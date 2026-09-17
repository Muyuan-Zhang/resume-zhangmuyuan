# Research-Ablation Dedup Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an append-only, project-local ledger (`.loopx-research-ablation/attempts.jsonl`) that records every ablation attempt's run directory, source paper, implementation variant, hyperparameters, and free-text description, plus two CLIs — `loopx-research-ablation-log-attempt` (write, with mandatory `--dedup-check` and `--run-dir` declarations) and `loopx-research-ablation-list-attempts` (query) — so a host agent can check what's already been tried before proposing a new module, and a later orphan-reconciliation sub-project can locate each attempt's files on disk.

**Architecture:** Pure-Python ledger module (`attempts_ledger.py`) that appends/parses/filters JSONL records, wrapped by two thin argparse CLIs in the same `loopx-research-ablation` package as the training monitor and benchmark-validation capabilities. No LoopX core dependency — same "package test convention" as the rest of this package (plain-assert smoke scripts, not pytest).

**Tech Stack:** Python 3.12, argparse, JSONL.

**Spec:** `docs/superpowers/specs/2026-09-06-research-ablation-dedup-design.md`

## Global Constraints

- Ledger file is append-only — no task may implement update/delete of existing lines.
- `--dedup-check` and `--run-dir` on `log-attempt` are both enforced as **manual checks inside the CLI** (`print(..., file=sys.stderr); return 1`), **not** via argparse `required=True` — argparse's own missing-required-argument path exits with code `2`, but the spec requires exit code `1` for these two cases specifically.
- `--dedup-check` values (run_ids) are never cross-validated against the ledger's own contents — no task may add that validation. `--run-dir` is likewise never checked for existence on disk by `log-attempt` itself (the attempt may be logged before the directory is created) — existence-checking belongs to the later orphan-reconciliation sub-project, not this one.
- `hyperparameters` is optional on `log-attempt` (default `{}` when omitted) — it is the one optional content field; `--run-id`, `--run-dir`, `--source`, `--technique`, `--description`, `--dedup-check` are all required.
- No task may touch LoopX core (`loopx/` outside `packages/loopx-research-ablation/`) or any file under `packages/loopx-research-ablation/` that belongs to the training-monitor or benchmark-validation capabilities (`sentinel.py`, `probe.py`, `classify.py`, `settlement.py`, `cli.py`, `benchmark.py`, `validate_cli.py`) — this plan only adds new files plus additive edits to `CONTRACT.md`/`README.md`/`pyproject.toml`.

---

### Task 1: Ledger Core (append + parse + filter)

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/attempts_ledger.py`
- Create: `packages/loopx-research-ablation/smoke/attempts_ledger_smoke.py`

**Interfaces:**
- Consumes: nothing from other tasks in this plan.
- Produces: `DEFAULT_LEDGER_PATH = ".loopx-research-ablation/attempts.jsonl"`; frozen dataclass `AttemptRecord(run_id: str, run_dir: str, source: str, technique: str, hyperparameters: dict, description: str, created_at: str, status: str, dedup_check: str)`; `append_attempt(ledger_path: Path, *, run_id: str, run_dir: str, source: str, technique: str, hyperparameters: dict, description: str, dedup_check: str) -> AttemptRecord` (no default for `dedup_check` or `run_dir` — both are keyword-only with no default, so calling without either is a `TypeError` at the Python level, mirroring the CLI's own enforcement one layer down); `list_attempts(ledger_path: Path, *, source_contains: str | None = None, technique: str | None = None) -> list[AttemptRecord]` (returns `[]` if the ledger file does not exist — never raises for a missing file, since "no attempts logged yet" is a normal state, not an error). Tasks 2 and 3 import both functions and `AttemptRecord`/`DEFAULT_LEDGER_PATH` from this module.

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/attempts_ledger_smoke.py
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from loopx_research_ablation.attempts_ledger import (
    AttemptRecord,
    append_attempt,
    list_attempts,
)


def test_append_creates_ledger_and_parent_dir():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / ".loopx-research-ablation" / "attempts.jsonl"
        record = append_attempt(
            ledger_path,
            run_id="abl.moe.001",
            run_dir="/data/runs/abl.moe.001",
            source="Switch Transformer (Fedus et al. 2021)",
            technique="moe-topk2-routing",
            hyperparameters={"num_experts": 8, "topk": 2},
            description="FFN层用MoE替换baseline",
            dedup_check="none",
        )
        assert record.run_id == "abl.moe.001"
        assert record.run_dir == "/data/runs/abl.moe.001"
        assert record.status == "pending"
        assert ledger_path.exists()
        lines = ledger_path.read_text().strip().splitlines()
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["run_dir"] == "/data/runs/abl.moe.001"
        assert parsed["hyperparameters"] == {"num_experts": 8, "topk": 2}
        assert parsed["dedup_check"] == "none"


def test_append_is_append_only():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        append_attempt(
            ledger_path, run_id="abl.a", run_dir="/data/runs/a", source="s", technique="t",
            hyperparameters={}, description="d", dedup_check="none",
        )
        append_attempt(
            ledger_path, run_id="abl.b", run_dir="/data/runs/b", source="s2", technique="t2",
            hyperparameters={}, description="d2", dedup_check="abl.a",
        )
        lines = ledger_path.read_text().strip().splitlines()
        assert len(lines) == 2


def test_append_requires_dedup_check_argument():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        try:
            append_attempt(  # type: ignore[call-arg]
                ledger_path, run_id="abl.a", run_dir="/data/runs/a", source="s", technique="t",
                hyperparameters={}, description="d",
            )
            raise AssertionError("expected TypeError for missing dedup_check")
        except TypeError:
            pass


def test_append_requires_run_dir_argument():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        try:
            append_attempt(  # type: ignore[call-arg]
                ledger_path, run_id="abl.a", source="s", technique="t",
                hyperparameters={}, description="d", dedup_check="none",
            )
            raise AssertionError("expected TypeError for missing run_dir")
        except TypeError:
            pass


def test_list_attempts_missing_ledger_returns_empty():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        assert list_attempts(ledger_path) == []


def test_list_attempts_filters_by_source_contains_case_insensitive():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        append_attempt(
            ledger_path, run_id="abl.a", run_dir="/data/runs/a",
            source="Switch Transformer (Fedus 2021)",
            technique="moe", hyperparameters={}, description="d", dedup_check="none",
        )
        append_attempt(
            ledger_path, run_id="abl.b", run_dir="/data/runs/b",
            source="Attention Is All You Need",
            technique="attn", hyperparameters={}, description="d2", dedup_check="none",
        )
        results = list_attempts(ledger_path, source_contains="switch")
        assert [r.run_id for r in results] == ["abl.a"]


def test_list_attempts_filters_by_technique_exact():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        append_attempt(
            ledger_path, run_id="abl.a", run_dir="/data/runs/a", source="s",
            technique="moe-topk2-routing",
            hyperparameters={}, description="d", dedup_check="none",
        )
        append_attempt(
            ledger_path, run_id="abl.b", run_dir="/data/runs/b", source="s",
            technique="moe-topk4-routing",
            hyperparameters={}, description="d", dedup_check="none",
        )
        results = list_attempts(ledger_path, technique="moe-topk2-routing")
        assert [r.run_id for r in results] == ["abl.a"]


def test_list_attempts_sorted_by_created_at_ascending():
    with tempfile.TemporaryDirectory() as workspace:
        ledger_path = Path(workspace) / "attempts.jsonl"
        append_attempt(
            ledger_path, run_id="abl.first", run_dir="/data/runs/first", source="s", technique="t",
            hyperparameters={}, description="d", dedup_check="none",
        )
        append_attempt(
            ledger_path, run_id="abl.second", run_dir="/data/runs/second", source="s", technique="t",
            hyperparameters={}, description="d", dedup_check="none",
        )
        results = list_attempts(ledger_path)
        assert [r.run_id for r in results] == ["abl.first", "abl.second"]


if __name__ == "__main__":
    test_append_creates_ledger_and_parent_dir()
    test_append_is_append_only()
    test_append_requires_dedup_check_argument()
    test_append_requires_run_dir_argument()
    test_list_attempts_missing_ledger_returns_empty()
    test_list_attempts_filters_by_source_contains_case_insensitive()
    test_list_attempts_filters_by_technique_exact()
    test_list_attempts_sorted_by_created_at_ascending()
    print("attempts_ledger_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/attempts_ledger_smoke.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'loopx_research_ablation.attempts_ledger'`

- [ ] **Step 3: Write `attempts_ledger.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/attempts_ledger.py
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LEDGER_PATH = ".loopx-research-ablation/attempts.jsonl"


@dataclass(frozen=True)
class AttemptRecord:
    run_id: str
    run_dir: str
    source: str
    technique: str
    hyperparameters: dict
    description: str
    created_at: str
    status: str
    dedup_check: str


def append_attempt(
    ledger_path: Path,
    *,
    run_id: str,
    run_dir: str,
    source: str,
    technique: str,
    hyperparameters: dict,
    description: str,
    dedup_check: str,
) -> AttemptRecord:
    """Append one attempt record. `dedup_check` and `run_dir` have no
    default on purpose: a caller (including this module's own future
    callers) cannot forget to pass either without a TypeError, mirroring
    the CLI's own enforcement. `run_dir` is recorded as given, never
    checked for existence here — that belongs to the later
    orphan-reconciliation sub-project, not this one."""
    record = AttemptRecord(
        run_id=run_id,
        run_dir=run_dir,
        source=source,
        technique=technique,
        hyperparameters=hyperparameters,
        description=description,
        created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        status="pending",
        dedup_check=dedup_check,
    )
    ledger_path = Path(ledger_path)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with ledger_path.open("a") as fh:
        fh.write(json.dumps(asdict(record), sort_keys=True))
        fh.write("\n")
    return record


def list_attempts(
    ledger_path: Path,
    *,
    source_contains: str | None = None,
    technique: str | None = None,
) -> list[AttemptRecord]:
    ledger_path = Path(ledger_path)
    if not ledger_path.exists():
        return []
    records = []
    for line in ledger_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        raw = json.loads(line)
        records.append(AttemptRecord(**raw))
    if source_contains is not None:
        needle = source_contains.lower()
        records = [r for r in records if needle in r.source.lower()]
    if technique is not None:
        records = [r for r in records if r.technique == technique]
    return sorted(records, key=lambda r: r.created_at)
```

- [ ] **Step 4: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/attempts_ledger_smoke.py`
Expected: prints `attempts_ledger_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/attempts_ledger.py packages/loopx-research-ablation/smoke/attempts_ledger_smoke.py
git commit -m "feat(research-ablation): add attempts ledger core"
```

---

### Task 2: `log-attempt` CLI

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/log_attempt_cli.py`
- Create: `packages/loopx-research-ablation/smoke/log_attempt_cli_smoke.py`

**Interfaces:**
- Consumes: `append_attempt`, `DEFAULT_LEDGER_PATH` from Task 1's `attempts_ledger.py`.
- Produces: `main(argv: list[str] | None = None) -> int`, the entrypoint referenced by a future `pyproject.toml` `[project.scripts] loopx-research-ablation-log-attempt = "loopx_research_ablation.log_attempt_cli:main"` (added in Task 4).

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/log_attempt_cli_smoke.py
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]


def _run_cli(workspace: Path, args: list[str]) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, "PYTHONPATH": str(PKG_ROOT / "src")}
    return subprocess.run(
        [sys.executable, "-m", "loopx_research_ablation.log_attempt_cli", *args],
        cwd=workspace,
        capture_output=True,
        text=True,
        env=env,
    )


def test_missing_dedup_check_exits_1_with_stderr_message():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run_cli(
            workspace,
            [
                "--run-id", "abl.a", "--run-dir", "/data/runs/a",
                "--source", "s", "--technique", "t", "--description", "d",
            ],
        )
        assert result.returncode == 1, result.stdout
        assert "dedup-check" in result.stderr.lower()
        assert not (workspace / ".loopx-research-ablation" / "attempts.jsonl").exists()


def test_missing_run_dir_exits_1_with_stderr_message():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run_cli(
            workspace,
            [
                "--run-id", "abl.a", "--source", "s", "--technique", "t",
                "--description", "d", "--dedup-check", "none",
            ],
        )
        assert result.returncode == 1, result.stdout
        assert "run-dir" in result.stderr.lower()
        assert not (workspace / ".loopx-research-ablation" / "attempts.jsonl").exists()


def test_successful_log_appends_record():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run_cli(
            workspace,
            [
                "--run-id", "abl.a", "--run-dir", "/data/runs/a",
                "--source", "Switch Transformer",
                "--technique", "moe-topk2-routing",
                "--hyperparameters", '{"num_experts": 8}',
                "--description", "d", "--dedup-check", "none",
            ],
        )
        assert result.returncode == 0, result.stderr
        ledger_path = workspace / ".loopx-research-ablation" / "attempts.jsonl"
        assert ledger_path.exists()
        record = json.loads(ledger_path.read_text().strip())
        assert record["run_dir"] == "/data/runs/a"
        assert record["hyperparameters"] == {"num_experts": 8}
        assert record["dedup_check"] == "none"


def test_hyperparameters_defaults_to_empty_dict():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run_cli(
            workspace,
            [
                "--run-id", "abl.a", "--run-dir", "/data/runs/a",
                "--source", "s", "--technique", "t",
                "--description", "d", "--dedup-check", "none",
            ],
        )
        assert result.returncode == 0, result.stderr
        ledger_path = workspace / ".loopx-research-ablation" / "attempts.jsonl"
        record = json.loads(ledger_path.read_text().strip())
        assert record["hyperparameters"] == {}


def test_malformed_hyperparameters_json_exits_1():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run_cli(
            workspace,
            [
                "--run-id", "abl.a", "--run-dir", "/data/runs/a",
                "--source", "s", "--technique", "t",
                "--hyperparameters", "{not json", "--description", "d",
                "--dedup-check", "none",
            ],
        )
        assert result.returncode == 1
        assert "hyperparameters" in result.stderr.lower()


if __name__ == "__main__":
    test_missing_dedup_check_exits_1_with_stderr_message()
    test_missing_run_dir_exits_1_with_stderr_message()
    test_successful_log_appends_record()
    test_hyperparameters_defaults_to_empty_dict()
    test_malformed_hyperparameters_json_exits_1()
    print("log_attempt_cli_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/log_attempt_cli_smoke.py`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write `log_attempt_cli.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/log_attempt_cli.py
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .attempts_ledger import DEFAULT_LEDGER_PATH, append_attempt


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="loopx-research-ablation-log-attempt")
    parser.add_argument("--run-id", required=True)
    # Deliberately NOT required=True for --run-dir or --dedup-check:
    # argparse's own missing-required-arg path exits 2, but both cases
    # must exit 1 per spec. Enforced manually in main() instead.
    parser.add_argument("--run-dir", default=None)
    parser.add_argument("--source", required=True)
    parser.add_argument("--technique", required=True)
    parser.add_argument("--hyperparameters", default=None)
    parser.add_argument("--description", required=True)
    parser.add_argument("--dedup-check", default=None)
    parser.add_argument("--ledger-path", default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = _parse_args(argv)

    if not args.run_dir:
        print(
            "validation error: --run-dir is required — it lets a later "
            "reconciliation pass find this attempt's files on disk",
            file=sys.stderr,
        )
        return 1

    if not args.dedup_check:
        print(
            "validation error: --dedup-check is required — run "
            "loopx-research-ablation-list-attempts first, then pass \"none\" "
            "or a comma-separated list of run_ids you compared against",
            file=sys.stderr,
        )
        return 1

    hyperparameters: dict = {}
    if args.hyperparameters:
        try:
            hyperparameters = json.loads(args.hyperparameters)
        except json.JSONDecodeError as exc:
            print(f"validation error: --hyperparameters is malformed JSON: {exc}", file=sys.stderr)
            return 1
        if not isinstance(hyperparameters, dict):
            print("validation error: --hyperparameters must be a JSON object", file=sys.stderr)
            return 1

    ledger_path = Path(args.ledger_path) if args.ledger_path else Path.cwd() / DEFAULT_LEDGER_PATH
    append_attempt(
        ledger_path,
        run_id=args.run_id,
        run_dir=args.run_dir,
        source=args.source,
        technique=args.technique,
        hyperparameters=hyperparameters,
        description=args.description,
        dedup_check=args.dedup_check,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/log_attempt_cli_smoke.py`
Expected: prints `log_attempt_cli_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/log_attempt_cli.py packages/loopx-research-ablation/smoke/log_attempt_cli_smoke.py
git commit -m "feat(research-ablation): add log-attempt CLI with mandatory dedup-check and run-dir"
```

---

### Task 3: `list-attempts` CLI

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/list_attempts_cli.py`
- Create: `packages/loopx-research-ablation/smoke/list_attempts_cli_smoke.py`

**Interfaces:**
- Consumes: `list_attempts`, `DEFAULT_LEDGER_PATH` from Task 1's `attempts_ledger.py`.
- Produces: `main(argv: list[str] | None = None) -> int`, entrypoint for a future `pyproject.toml` `[project.scripts] loopx-research-ablation-list-attempts = "loopx_research_ablation.list_attempts_cli:main"` (added in Task 4).

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/list_attempts_cli_smoke.py
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]


def _run_cli(workspace: Path, args: list[str]) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, "PYTHONPATH": str(PKG_ROOT / "src")}
    return subprocess.run(
        [sys.executable, "-m", "loopx_research_ablation.list_attempts_cli", *args],
        cwd=workspace,
        capture_output=True,
        text=True,
        env=env,
    )


def _log_one(workspace: Path, run_id: str, source: str, technique: str) -> None:
    ledger_dir = workspace / ".loopx-research-ablation"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    ledger_path = ledger_dir / "attempts.jsonl"
    line = json.dumps(
        {
            "run_id": run_id, "run_dir": f"/data/runs/{run_id}",
            "source": source, "technique": technique,
            "hyperparameters": {}, "description": f"desc for {run_id}",
            "created_at": "2026-09-06T00:00:00Z", "status": "pending",
            "dedup_check": "none",
        }
    )
    with ledger_path.open("a") as fh:
        fh.write(line + "\n")


def test_no_filters_lists_all():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        _log_one(workspace, "abl.a", "Switch Transformer", "moe")
        _log_one(workspace, "abl.b", "Attention Is All You Need", "attn")
        result = _run_cli(workspace, [])
        assert result.returncode == 0, result.stderr
        assert "abl.a" in result.stdout
        assert "abl.b" in result.stdout


def test_source_contains_filters():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        _log_one(workspace, "abl.a", "Switch Transformer", "moe")
        _log_one(workspace, "abl.b", "Attention Is All You Need", "attn")
        result = _run_cli(workspace, ["--source-contains", "switch"])
        assert result.returncode == 0, result.stderr
        assert "abl.a" in result.stdout
        assert "abl.b" not in result.stdout


def test_technique_filters_exact():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        _log_one(workspace, "abl.a", "s", "moe-topk2-routing")
        _log_one(workspace, "abl.b", "s", "moe-topk4-routing")
        result = _run_cli(workspace, ["--technique", "moe-topk2-routing"])
        assert result.returncode == 0, result.stderr
        assert "abl.a" in result.stdout
        assert "abl.b" not in result.stdout


def test_missing_ledger_prints_nothing_and_exits_0():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run_cli(workspace, [])
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == ""


if __name__ == "__main__":
    test_no_filters_lists_all()
    test_source_contains_filters()
    test_technique_filters_exact()
    test_missing_ledger_prints_nothing_and_exits_0()
    print("list_attempts_cli_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/list_attempts_cli_smoke.py`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write `list_attempts_cli.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/list_attempts_cli.py
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

from .attempts_ledger import DEFAULT_LEDGER_PATH, list_attempts


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="loopx-research-ablation-list-attempts")
    parser.add_argument("--source-contains", default=None)
    parser.add_argument("--technique", default=None)
    parser.add_argument("--ledger-path", default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = _parse_args(argv)
    ledger_path = Path(args.ledger_path) if args.ledger_path else Path.cwd() / DEFAULT_LEDGER_PATH
    records = list_attempts(
        ledger_path,
        source_contains=args.source_contains,
        technique=args.technique,
    )
    for record in records:
        print(json.dumps(asdict(record), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/list_attempts_cli_smoke.py`
Expected: prints `list_attempts_cli_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/list_attempts_cli.py packages/loopx-research-ablation/smoke/list_attempts_cli_smoke.py
git commit -m "feat(research-ablation): add list-attempts CLI"
```

---

### Task 4: Packaging And Docs

**Files:**
- Create or Modify: `packages/loopx-research-ablation/pyproject.toml` (create if absent, add to `[project.scripts]` if another plan created it first — check before writing)
- Modify: `packages/loopx-research-ablation/CONTRACT.md` (already exists from the benchmark-validation feature and, if that plan already ran, the training-monitor feature — add a new section, do not overwrite existing content)
- Modify: `packages/loopx-research-ablation/README.md` (same — add a new section, do not overwrite existing content)
- Create: `packages/loopx-research-ablation/smoke/dedup_end_to_end_smoke.py`

**Interfaces:**
- Consumes: `log_attempt_cli.main`, `list_attempts_cli.main` (via subprocess, same pattern as Tasks 2/3's own smoke tests).
- Produces: nothing further downstream — this is the plan's acceptance test.

- [ ] **Step 1: Check whether `pyproject.toml` already exists, then create or extend it**

Run: `test -f packages/loopx-research-ablation/pyproject.toml && echo EXISTS || echo MISSING`

**If `MISSING`**, write it fresh:

```toml
[project]
name = "loopx-research-ablation"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["loopx"]

[project.scripts]
loopx-research-ablation-log-attempt = "loopx_research_ablation.log_attempt_cli:main"
loopx-research-ablation-list-attempts = "loopx_research_ablation.list_attempts_cli:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
```

**If `EXISTS`** (another plan's task created it first — most likely with `loopx-research-ablation` and/or `loopx-research-ablation-validate` entries already present under `[project.scripts]`), read the file, then use the Edit tool to add exactly these two lines inside the existing `[project.scripts]` table, next to whatever is already there, without removing or reordering existing entries:

```toml
loopx-research-ablation-log-attempt = "loopx_research_ablation.log_attempt_cli:main"
loopx-research-ablation-list-attempts = "loopx_research_ablation.list_attempts_cli:main"
```

- [ ] **Step 2: Read the existing `CONTRACT.md` and `README.md`, then append a new section to each**

Read both files first (they exist). Append this section to the end of `CONTRACT.md` (after its existing content, do not touch what's there):

```markdown

## Dedup Ledger

`.loopx-research-ablation/attempts.jsonl` (project repo, append-only JSONL)
records every ablation attempt so a host agent can check what has already
been tried before proposing a new module, and so a later reconciliation
pass can find each attempt's files on disk.

### Ownership

| Surface | Owner | Responsibility |
| --- | --- | --- |
| Ledger schema | `attempts_ledger.py` | Record shape, append-only guarantee |
| Write path | `loopx-research-ablation-log-attempt` | Mandatory `--dedup-check` and `--run-dir` declarations before any record is written |
| Query path | `loopx-research-ablation-list-attempts` | Filtering by source/technique for a host to read before proposing |

### Record shape

```json
{"run_id": "abl.moe-topk2.20260906-1430", "run_dir": "/data/runs/abl.moe-topk2.20260906-1430", "source": "Switch Transformer (Fedus et al. 2021)", "technique": "moe-topk2-routing", "hyperparameters": {"num_experts": 8, "topk": 2}, "description": "...", "created_at": "2026-09-06T14:30:00Z", "status": "pending", "dedup_check": "none"}
```

### Rules

- `log-attempt` refuses to write (exit `1`) without `--dedup-check` — a
  human/host must declare `"none"` or the run_ids it compared against.
  This is never cross-validated against the ledger; it is an auditable
  declaration, not a verified check.
- `log-attempt` likewise refuses to write (exit `1`) without `--run-dir` —
  recorded as given, never checked for existence at write time (the
  directory may not exist yet when the attempt is first logged).
- The ledger is append-only. No command in this package updates or deletes
  an existing line.
- `hyperparameters` and `technique`/`source` similarity are never compared
  automatically — a host reads `list-attempts`' output and judges for itself.

### Invocation

```
loopx-research-ablation-log-attempt --run-id <id> --run-dir <path> --source <str> --technique <str> [--hyperparameters '<json>'] --description <str> --dedup-check <"none"|"id1,id2">
loopx-research-ablation-list-attempts [--source-contains <str>] [--technique <str>]
```
```

Append this section to the end of `README.md`:

```markdown

## Dedup Ledger

Before proposing a new ablation module, check what has already been tried:

```bash
loopx-research-ablation-list-attempts --source-contains "moe"
```

Then log the new attempt, declaring what you checked and where it will run:

```bash
loopx-research-ablation-log-attempt --run-id abl.moe-topk2.20260906-1430 \
  --run-dir /data/runs/abl.moe-topk2.20260906-1430 \
  --source "Switch Transformer (Fedus et al. 2021)" --technique moe-topk2-routing \
  --hyperparameters '{"num_experts": 8, "topk": 2}' \
  --description "FFN层用MoE替换baseline，topk=2" \
  --dedup-check none
```

See `CONTRACT.md` for the full record schema and rules.
```

- [ ] **Step 3: Write the end-to-end smoke test**

```python
# packages/loopx-research-ablation/smoke/dedup_end_to_end_smoke.py
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]


def _run(workspace: Path, module: str, args: list[str]) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(PKG_ROOT / "src")}
    return subprocess.run(
        [sys.executable, "-m", module, *args],
        cwd=workspace,
        capture_output=True,
        text=True,
        env=env,
    )


def test_log_then_list_round_trip():
    with tempfile.TemporaryDirectory() as workspace:
        workspace = Path(workspace)
        result = _run(
            workspace,
            "loopx_research_ablation.log_attempt_cli",
            [
                "--run-id", "abl.e2e.001", "--run-dir", "/data/runs/abl.e2e.001",
                "--source", "Switch Transformer",
                "--technique", "moe-topk2-routing",
                "--hyperparameters", '{"num_experts": 8}',
                "--description", "end to end smoke", "--dedup-check", "none",
            ],
        )
        assert result.returncode == 0, result.stderr

        result = _run(
            workspace, "loopx_research_ablation.list_attempts_cli",
            ["--source-contains", "switch"],
        )
        assert result.returncode == 0, result.stderr
        assert "abl.e2e.001" in result.stdout

        result = _run(
            workspace, "loopx_research_ablation.list_attempts_cli",
            ["--technique", "moe-topk4-routing"],
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == ""


if __name__ == "__main__":
    test_log_then_list_round_trip()
    print("dedup_end_to_end_smoke: OK")
```

- [ ] **Step 4: Run the full smoke suite for this plan's files**

Run: `python packages/loopx-research-ablation/smoke/attempts_ledger_smoke.py && python packages/loopx-research-ablation/smoke/log_attempt_cli_smoke.py && python packages/loopx-research-ablation/smoke/list_attempts_cli_smoke.py && python packages/loopx-research-ablation/smoke/dedup_end_to_end_smoke.py`
Expected: all four print their `OK` line.

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/pyproject.toml packages/loopx-research-ablation/CONTRACT.md packages/loopx-research-ablation/README.md packages/loopx-research-ablation/smoke/dedup_end_to_end_smoke.py
git commit -m "feat(research-ablation): package dedup CLIs and document the ledger"
```
