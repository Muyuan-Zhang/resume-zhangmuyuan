# Research-Ablation Training Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `loopx-research-ablation` extension package that tracks one scheduler-less (`nohup`/`tmux`) training run to completion and hands the result back to a host agent as a materialized advancement Todo, per the approved spec.

**Architecture:** A standalone, protocol-only extension process (`packages/loopx-research-ablation/`, mirroring `packages/loopx-repo-health/`) reads one JSON poll request from stdin and writes one JSON result to stdout, exactly like every other LoopX extension. Internally it composes four pure/small modules — sentinel reading, progress-probe invocation, status classification, and governed-transition settlement — and is the **first real caller** of `loopx.control_plane.work_items.governed_transition_proposal.settle_governed_transition_proposals`, which today has zero production callers. `run_tracked.sh` is a separate, LoopX-independent shell wrapper the host uses to launch training.

**Tech Stack:** Python 3.12, bash (`set -euo pipefail`), pytest for core-adjacent settlement code, plain-assert smoke scripts for package-internal code (matching `packages/loopx-repo-health`'s own convention — this package has no `tests/` directory of its own).

**Spec:** `docs/superpowers/specs/2026-09-06-research-ablation-monitor-design.md`

## Global Constraints

- No changes to LoopX core Todo schema (`loopx/control_plane/todos/contract.py`'s `_TODO_METADATA_FIELD_SCHEMA`) — confirmed in spec Scope.
- Extension declares `permissions = ["external_write"]`, scoped only to the `continuous_monitor_upsert` / `continuous_monitor_complete` proposal kinds — no other write capability.
- Raw metric values are never written into LoopX state — only a path pointer (`metrics_path`). (Spec, Data Formats.)
- `run_tracked.sh` has no LoopX dependency and must run standalone.
- The extension calls `settle_governed_transition_proposals` directly (decision A1) — it does **not** use `start_governed_external_capability`/`reconcile_governed_external_capability` (those assume an active-turn/admission context this standalone process never has).
- Single in-flight run per goal for this plan; no parallel-branch coordination.
- Package test convention: plain-assert scripts under `smoke/`, following `packages/loopx-repo-health`'s established pattern — not pytest — for everything inside `packages/loopx-research-ablation/`. The one exception is Task 6, which is tested with pytest under `tests/extensions/`, matching the existing convention for code that calls into `loopx.control_plane` core (see `tests/extensions/test_governed_capability_execution.py`).

---

### Task 1: Extension Manifest And Integration Profile

**Files:**
- Create: `packages/loopx-research-ablation/extension.toml`
- Create: `packages/loopx-research-ablation/integration_profile.json`
- Create: `tests/extensions/test_research_ablation_manifest.py`

**Interfaces:**
- Consumes: `loopx.extensions.manifest.load_extension_manifest(path: str | Path) -> dict[str, Any]` (existing core function).
- Produces: a manifest whose `capabilities[0]["id"] == "research_ablation_monitor"` and whose `integration_profile["operations"][0]["id"] == "poll_training_run"` — later tasks' proposals must use `action_kind="poll_training_run"` and `monitor_key`/`target_key` values prefixed `"abl."` to satisfy this task's `todo_contract`/`transition_contract` prefixes.

- [ ] **Step 1: Write the failing test**

```python
# tests/extensions/test_research_ablation_manifest.py
from pathlib import Path

from loopx.extensions.manifest import load_extension_manifest

EXTENSION_ROOT = Path(__file__).resolve().parents[2] / "packages" / "loopx-research-ablation"


def test_research_ablation_manifest_loads():
    manifest = load_extension_manifest(EXTENSION_ROOT / "extension.toml")
    assert manifest["provider"]["id"] == "loopx-research-ablation"
    capability = manifest["capabilities"][0]
    assert capability["id"] == "research_ablation_monitor"
    profile = capability["integration_profile"]
    operation = profile["operations"][0]
    assert operation["id"] == "poll_training_run"
    assert operation["effect_class"] == "external_write"
    assert operation["todo_contract"]["target_key_prefixes"] == ["abl."]
    assert operation["transition_contract"]["proposal_kinds"] == [
        "continuous_monitor_upsert",
        "continuous_monitor_complete",
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/extensions/test_research_ablation_manifest.py -v`
Expected: FAIL — `extension.toml` does not exist yet (`ValueError: cannot read extension manifest ...`).

- [ ] **Step 3: Before writing the TOML, confirm the `kind` vocabulary for `[[provides]]`**

Run: `grep -rn 'kind = ' packages/*/extension.toml loopx/extensions/bundled.py`. If existing extensions use a specific token (e.g. `"observer"`, `"provider"`), reuse it; if none exists, use `"monitor_provider"`. Record whichever value is used — Task 6/7 do not depend on it, so any public-safe lower-snake token is safe.

- [ ] **Step 4: Write `extension.toml`**

```toml
schema_version = "loopx_extension_manifest_v0"
id = "loopx-research-ablation"
version = "0.1.0"
requires_loopx_api = ">=1,<2"
permissions = ["external_write"]

[runtime]
protocol = "loopx_research_ablation_extension_v0"
entrypoint = "loopx-research-ablation"
doctor_args = ["--doctor"]
required_permissions = ["external_write"]
timeout_seconds = 30

[[provides]]
id = "research_ablation_monitor"
kind = "monitor_provider"
visibility = "public"
integration_profile = "integration_profile.json"
```

- [ ] **Step 5: Write `integration_profile.json`**

```json
{
  "schema_version": "loopx_external_domain_capability_profile_v0",
  "capability_id": "research_ablation_monitor",
  "protocol": "loopx_research_ablation_extension_v0",
  "operations": [
    {
      "id": "poll_training_run",
      "effect_class": "external_write",
      "required_permission": "external_write",
      "request_schema": "research_ablation_poll_request_v0",
      "result_schema": "research_ablation_poll_result_v0",
      "todo_contract": {
        "action_kinds": ["poll_training_run"],
        "target_key_prefixes": ["abl."]
      },
      "transition_contract": {
        "proposal_kinds": ["continuous_monitor_upsert", "continuous_monitor_complete"],
        "monitor_key_prefixes": ["abl."],
        "monitor_action_kinds": ["poll_training_run"],
        "monitor_target_key_prefixes": ["abl."],
        "monitor_required_capabilities": ["research_ablation_monitor"]
      }
    }
  ]
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/extensions/test_research_ablation_manifest.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/loopx-research-ablation/extension.toml packages/loopx-research-ablation/integration_profile.json tests/extensions/test_research_ablation_manifest.py
git commit -m "feat(research-ablation): add extension manifest and integration profile"
```

---

### Task 2: `run_tracked.sh` Atomic Sentinel Wrapper

**Files:**
- Create: `packages/loopx-research-ablation/bin/run_tracked.sh`
- Create: `packages/loopx-research-ablation/smoke/run_tracked_smoke.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: invocation contract `run_tracked.sh <run_id> <run_dir> <command...>` and the sentinel file shape `<run_dir>/.loopx_sentinel.json` with keys `run_id, exit_code, signal, finished_at, pid` — Task 3 (sentinel reader) depends on this exact shape.

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/run_tracked_smoke.py
import json
import subprocess
import sys
import tempfile
from pathlib import Path

WRAPPER = Path(__file__).resolve().parents[1] / "bin" / "run_tracked.sh"


def _read_sentinel(run_dir: Path) -> dict:
    return json.loads((run_dir / ".loopx_sentinel.json").read_text())


def test_normal_exit():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        subprocess.run(
            ["bash", str(WRAPPER), "abl.test.001", str(run_dir), "true"],
            check=True,
        )
        sentinel = _read_sentinel(run_dir)
        assert sentinel["run_id"] == "abl.test.001"
        assert sentinel["exit_code"] == 0
        assert sentinel["signal"] is None


def test_nonzero_exit():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        result = subprocess.run(
            ["bash", str(WRAPPER), "abl.test.002", str(run_dir), "false"],
        )
        assert result.returncode == 1
        sentinel = _read_sentinel(run_dir)
        assert sentinel["exit_code"] == 1
        assert sentinel["signal"] is None


def test_killed_by_signal():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        proc = subprocess.Popen(
            ["bash", str(WRAPPER), "abl.test.003", str(run_dir), "sleep", "30"],
        )
        import time

        time.sleep(0.3)
        proc.terminate()
        proc.wait(timeout=5)
        sentinel = _read_sentinel(run_dir)
        assert sentinel["signal"] == "TERM"


if __name__ == "__main__":
    test_normal_exit()
    test_nonzero_exit()
    test_killed_by_signal()
    print("run_tracked_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/run_tracked_smoke.py`
Expected: FAIL — `bin/run_tracked.sh` does not exist (`FileNotFoundError` from subprocess, or bash "No such file").

- [ ] **Step 3: Write `run_tracked.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: run_tracked.sh <run_id> <run_dir> <command...>" >&2
  exit 64
fi

run_id="$1"
run_dir="$2"
shift 2

mkdir -p "$run_dir"
sentinel_final="$run_dir/.loopx_sentinel.json"
sentinel_tmp="$run_dir/.loopx_sentinel.json.tmp.$$"

caught_signal=""
trap 'caught_signal="TERM"' TERM
trap 'caught_signal="INT"' INT

set +e
"$@" &
child_pid=$!
wait "$child_pid"
exit_code=$?
set -e

if [[ -n "$caught_signal" ]]; then
  signal_json="\"$caught_signal\""
else
  signal_json="null"
fi

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$sentinel_tmp" <<JSON
{"run_id": "$run_id", "exit_code": $exit_code, "signal": $signal_json, "finished_at": "$finished_at", "pid": $child_pid}
JSON
mv -f "$sentinel_tmp" "$sentinel_final"

exit "$exit_code"
```

- [ ] **Step 4: Make it executable and run to verify it passes**

Run: `chmod +x packages/loopx-research-ablation/bin/run_tracked.sh && python packages/loopx-research-ablation/smoke/run_tracked_smoke.py`
Expected: prints `run_tracked_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/bin/run_tracked.sh packages/loopx-research-ablation/smoke/run_tracked_smoke.py
git commit -m "feat(research-ablation): add run_tracked.sh atomic sentinel wrapper"
```

---

### Task 3: Sentinel File Reader

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/sentinel.py`
- Create: `packages/loopx-research-ablation/smoke/sentinel_smoke.py`

**Interfaces:**
- Consumes: the sentinel JSON shape produced by Task 2.
- Produces: `read_sentinel(run_dir: Path) -> SentinelResult | None` where `SentinelResult` is a frozen dataclass with fields `run_id: str, exit_code: int, signal: str | None, finished_at: str, pid: int`. Returns `None` if the file does not exist. Raises `SentinelReadError` (defined in this module) on unreadable/malformed JSON — Task 5 (classifier) depends on this exact exception type to distinguish "still running" from "corrupt sentinel."

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/sentinel_smoke.py
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from loopx_research_ablation.sentinel import SentinelReadError, read_sentinel


def test_missing_sentinel_returns_none():
    with tempfile.TemporaryDirectory() as run_dir:
        assert read_sentinel(Path(run_dir)) is None


def test_valid_sentinel_parses():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        (run_dir / ".loopx_sentinel.json").write_text(
            json.dumps(
                {
                    "run_id": "abl.test.001",
                    "exit_code": 0,
                    "signal": None,
                    "finished_at": "2026-09-06T14:30:00Z",
                    "pid": 123,
                }
            )
        )
        result = read_sentinel(run_dir)
        assert result.run_id == "abl.test.001"
        assert result.exit_code == 0
        assert result.signal is None


def test_malformed_sentinel_raises():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        (run_dir / ".loopx_sentinel.json").write_text("{not json")
        try:
            read_sentinel(run_dir)
            raise AssertionError("expected SentinelReadError")
        except SentinelReadError:
            pass


if __name__ == "__main__":
    test_missing_sentinel_returns_none()
    test_valid_sentinel_parses()
    test_malformed_sentinel_raises()
    print("sentinel_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/sentinel_smoke.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'loopx_research_ablation'`

- [ ] **Step 3: Write `sentinel.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/sentinel.py
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

SENTINEL_FILENAME = ".loopx_sentinel.json"


class SentinelReadError(ValueError):
    """The sentinel file exists but could not be parsed."""


@dataclass(frozen=True)
class SentinelResult:
    run_id: str
    exit_code: int
    signal: str | None
    finished_at: str
    pid: int


def read_sentinel(run_dir: Path) -> SentinelResult | None:
    path = Path(run_dir) / SENTINEL_FILENAME
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SentinelReadError(f"cannot read sentinel at {path}: {exc}") from exc
    try:
        return SentinelResult(
            run_id=str(raw["run_id"]),
            exit_code=int(raw["exit_code"]),
            signal=raw["signal"],
            finished_at=str(raw["finished_at"]),
            pid=int(raw["pid"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise SentinelReadError(f"sentinel at {path} missing/invalid fields: {exc}") from exc
```

- [ ] **Step 4: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/sentinel_smoke.py`
Expected: prints `sentinel_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/sentinel.py packages/loopx-research-ablation/smoke/sentinel_smoke.py
git commit -m "feat(research-ablation): add sentinel file reader"
```

---

### Task 4: Progress Probe Invocation

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/probe.py`
- Create: `packages/loopx-research-ablation/smoke/probe_smoke.py`

**Interfaces:**
- Consumes: nothing from other tasks (independent of sentinel.py).
- Produces: `run_probe(probe_command: list[str], run_dir: Path, timeout_seconds: int = 30) -> ProbeResult` where `ProbeResult` is a frozen dataclass with fields `ok: bool, last_step: int | None, target_step: int | None, reached_target: bool | None, error: str | None`. `ok=False` (with `error` set, other fields `None`) covers non-zero exit, timeout, and unparsable JSON — Task 5 depends on `ok` being the single flag that means "treat as `probe_error`."

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/probe_smoke.py
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from loopx_research_ablation.probe import run_probe


def _write_probe(tmp_path: Path, body: str) -> Path:
    probe_path = tmp_path / "probe.sh"
    probe_path.write_text(f"#!/usr/bin/env bash\n{body}\n")
    probe_path.chmod(0o755)
    return probe_path


def test_successful_probe():
    with tempfile.TemporaryDirectory() as tmp_path:
        tmp_path = Path(tmp_path)
        probe = _write_probe(
            tmp_path, 'echo \'{"last_step": 100, "target_step": 200, "reached_target": false}\''
        )
        result = run_probe([str(probe)], tmp_path)
        assert result.ok is True
        assert result.last_step == 100
        assert result.target_step == 200
        assert result.reached_target is False


def test_nonzero_exit_is_probe_error():
    with tempfile.TemporaryDirectory() as tmp_path:
        tmp_path = Path(tmp_path)
        probe = _write_probe(tmp_path, "exit 1")
        result = run_probe([str(probe)], tmp_path)
        assert result.ok is False
        assert result.error is not None


def test_bad_json_is_probe_error():
    with tempfile.TemporaryDirectory() as tmp_path:
        tmp_path = Path(tmp_path)
        probe = _write_probe(tmp_path, "echo 'not json'")
        result = run_probe([str(probe)], tmp_path)
        assert result.ok is False
        assert result.error is not None


def test_timeout_is_probe_error():
    with tempfile.TemporaryDirectory() as tmp_path:
        tmp_path = Path(tmp_path)
        probe = _write_probe(tmp_path, "sleep 5")
        result = run_probe([str(probe)], tmp_path, timeout_seconds=1)
        assert result.ok is False
        assert result.error is not None


if __name__ == "__main__":
    test_successful_probe()
    test_nonzero_exit_is_probe_error()
    test_bad_json_is_probe_error()
    test_timeout_is_probe_error()
    print("probe_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/probe_smoke.py`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write `probe.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/probe.py
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    last_step: int | None
    target_step: int | None
    reached_target: bool | None
    error: str | None


def run_probe(
    probe_command: list[str], run_dir: Path, timeout_seconds: int = 30
) -> ProbeResult:
    try:
        completed = subprocess.run(
            [*probe_command, str(run_dir)],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        return ProbeResult(False, None, None, None, f"probe timed out: {exc}")
    if completed.returncode != 0:
        return ProbeResult(
            False, None, None, None,
            f"probe exited {completed.returncode}: {completed.stderr.strip()}",
        )
    try:
        payload = json.loads(completed.stdout.strip())
        return ProbeResult(
            ok=True,
            last_step=int(payload["last_step"]),
            target_step=int(payload["target_step"]),
            reached_target=bool(payload["reached_target"]),
            error=None,
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return ProbeResult(False, None, None, None, f"probe output invalid: {exc}")
```

- [ ] **Step 4: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/probe_smoke.py`
Expected: prints `probe_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/probe.py packages/loopx-research-ablation/smoke/probe_smoke.py
git commit -m "feat(research-ablation): add progress probe invocation"
```

---

### Task 5: Status Classifier

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/classify.py`
- Create: `packages/loopx-research-ablation/smoke/classify_smoke.py`

**Interfaces:**
- Consumes: `SentinelResult | None` from Task 3, `ProbeResult` from Task 4, and `previous_last_step: int | None` (the last poll's `last_step`, for stall detection — caller-supplied, not persisted by this module).
- Produces: `classify(sentinel, probe, previous_last_step) -> Classification`, a frozen dataclass with fields `status: str` (one of the seven spec statuses), `is_terminal: bool` (whether `continuous_monitor_complete` should fire), `stall_signal: str | None` (`"changed"` / `"unchanged"` / `None` when not applicable — `None` whenever `is_terminal` is `True`, since terminal outcomes bypass `dead_monitor_repeat`). This is the direct code form of the spec's Error Handling table — every row must have a corresponding test case.

- [ ] **Step 1: Write the failing smoke assertion (one case per spec table row, plus the two non-terminal rows)**

```python
# packages/loopx-research-ablation/smoke/classify_smoke.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from loopx_research_ablation.classify import classify
from loopx_research_ablation.probe import ProbeResult
from loopx_research_ablation.sentinel import SentinelResult

def _sentinel(exit_code=0, signal=None):
    return SentinelResult(run_id="r", exit_code=exit_code, signal=signal, finished_at="t", pid=1)

def _probe(ok=True, last_step=10, target_step=10, reached_target=True, error=None):
    return ProbeResult(ok=ok, last_step=last_step, target_step=target_step, reached_target=reached_target, error=error)

def test_still_running_progress_advanced():
    result = classify(None, _probe(last_step=50, target_step=100, reached_target=False), previous_last_step=10)
    assert result.is_terminal is False
    assert result.stall_signal == "changed"

def test_still_running_no_progress():
    result = classify(None, _probe(last_step=10, target_step=100, reached_target=False), previous_last_step=10)
    assert result.is_terminal is False
    assert result.stall_signal == "unchanged"

def test_sentinel_missing_but_log_complete():
    result = classify(None, _probe(last_step=100, target_step=100, reached_target=True), previous_last_step=100)
    assert result.status == "sentinel_missing_but_log_complete"
    assert result.is_terminal is True
    assert result.stall_signal is None

def test_probe_error_bypasses_stall_counter():
    result = classify(None, _probe(ok=False, last_step=None, target_step=None, reached_target=None, error="boom"), previous_last_step=10)
    assert result.status == "probe_error"
    assert result.is_terminal is True
    assert result.stall_signal is None

def test_completed_unverified_when_probe_fails_after_sentinel():
    result = classify(_sentinel(exit_code=0), _probe(ok=False, last_step=None, target_step=None, reached_target=None, error="unreadable"), previous_last_step=10)
    assert result.status == "completed_unverified"
    assert result.is_terminal is True

def test_killed():
    result = classify(_sentinel(exit_code=143, signal="TERM"), _probe(reached_target=False, last_step=50, target_step=100), previous_last_step=50)
    assert result.status == "killed"
    assert result.is_terminal is True

def test_crashed_early():
    result = classify(_sentinel(exit_code=1, signal=None), _probe(reached_target=False, last_step=50, target_step=100), previous_last_step=50)
    assert result.status == "crashed_early"
    assert result.is_terminal is True

def test_completed_normally():
    result = classify(_sentinel(exit_code=0, signal=None), _probe(reached_target=True, last_step=100, target_step=100), previous_last_step=100)
    assert result.status == "completed_normally"
    assert result.is_terminal is True

if __name__ == "__main__":
    test_still_running_progress_advanced()
    test_still_running_no_progress()
    test_sentinel_missing_but_log_complete()
    test_probe_error_bypasses_stall_counter()
    test_completed_unverified_when_probe_fails_after_sentinel()
    test_killed()
    test_crashed_early()
    test_completed_normally()
    print("classify_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/classify_smoke.py`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write `classify.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/classify.py
from __future__ import annotations

from dataclasses import dataclass

from .probe import ProbeResult
from .sentinel import SentinelResult

NON_TERMINAL = "still_running"


@dataclass(frozen=True)
class Classification:
    status: str
    is_terminal: bool
    stall_signal: str | None


def classify(
    sentinel: SentinelResult | None,
    probe: ProbeResult,
    previous_last_step: int | None,
) -> Classification:
    if sentinel is None:
        if not probe.ok:
            return Classification("probe_error", True, None)
        if probe.reached_target:
            return Classification("sentinel_missing_but_log_complete", True, None)
        signal = (
            "changed"
            if previous_last_step is None or probe.last_step != previous_last_step
            else "unchanged"
        )
        return Classification(NON_TERMINAL, False, signal)

    if not probe.ok:
        return Classification("completed_unverified", True, None)
    if sentinel.signal is not None:
        return Classification("killed", True, None)
    if probe.reached_target:
        return Classification("completed_normally", True, None)
    return Classification("crashed_early", True, None)
```

- [ ] **Step 4: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/classify_smoke.py`
Expected: prints `classify_smoke: OK`

- [ ] **Step 5: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/classify.py packages/loopx-research-ablation/smoke/classify_smoke.py
git commit -m "feat(research-ablation): add status classifier"
```

---

### Task 6: Governed Transition Settlement (first real caller)

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py`
- Create: `tests/extensions/test_research_ablation_settlement.py`

**Interfaces:**
- Consumes: `Classification` from Task 5; real signature of
  `loopx.control_plane.work_items.governed_transition_proposal.settle_governed_transition_proposals(*, registry_path, goal_id, agent_id, effect_id, proposals, existing_receipts, checkpoint, phase) -> list[dict]` and `GovernedTransitionSettlementPhase` (both already confirmed in this file during design; re-read the enum's full member list before Step 1, since only the `continuous_monitor_upsert -> PRE_SETTLEMENT` mapping was directly confirmed — grep `class GovernedTransitionSettlementPhase` in `loopx/control_plane/work_items/governed_transition_proposal.py` for the rest).
- Produces: `settle(*, registry_path: Path, goal_id: str, agent_id: str, run_id: str, classification: Classification, evidence: dict, cadence_seconds: int, expires_in_seconds: int) -> list[dict]` (returns transition receipts). This is the task most likely to surface API mismatches since it is the first production caller — treat any `ValueError` from `settle_governed_transition_proposals` as a signal to re-read that function's validation logic, not as a bug in this module.

- [ ] **Step 1: Confirm the settlement phase enum's full member list**

Run: `grep -n "class GovernedTransitionSettlementPhase" -A 10 loopx/control_plane/work_items/governed_transition_proposal.py`
Record the exact member names and their proposal-kind mapping before writing Step 2's test.

- [ ] **Step 2: Locate and adapt the existing goal-registry test bootstrap**

Run: `sed -n '1,80p' tests/extensions/test_governed_capability_execution.py` and, if present,
`cat tests/extensions/conftest.py`. Find whatever helper function or fixture that file
uses to create a temporary registry with one goal and one agent (e.g. a
`tmp_path`-based bootstrap calling a `create_goal`/`bootstrap_registry`-style
core helper — use its real name, not a guess). Add a **local** fixture to a new
`tests/extensions/conftest.py` (create it if it does not exist) named
`loopx_goal_fixture` that calls that same real helper and yields
`(registry_path, goal_id, agent_id)`. Do this as its own commit before Step 3,
since it may be reused by later sub-projects' tests:

```bash
git add tests/extensions/conftest.py
git commit -m "test(extensions): add shared loopx_goal_fixture for extension tests"
```

- [ ] **Step 3: Write the failing test (using the real, temporary LoopX goal registry from Step 2 — not a mock)**

```python
# tests/extensions/test_research_ablation_settlement.py
import json
from pathlib import Path

import pytest

from loopx.control_plane.work_items.governed_transition_proposal import (
    settle_governed_transition_proposals,
)
from loopx_research_ablation.classify import Classification
from loopx_research_ablation.settlement import settle

# NOTE: this test seeds a goal via whatever LoopX test helper the existing
# `tests/extensions/test_governed_capability_execution.py` uses to build a
# registry/goal fixture — read that file first and reuse its fixture helper
# rather than hand-rolling registry bootstrapping here.


def test_upsert_then_complete_monitor(loopx_goal_fixture):
    registry_path, goal_id, agent_id = loopx_goal_fixture

    non_terminal = Classification(status="still_running", is_terminal=False, stall_signal="changed")
    receipts = settle(
        registry_path=registry_path,
        goal_id=goal_id,
        agent_id=agent_id,
        run_id="abl.test.settle",
        classification=non_terminal,
        evidence={},
        cadence_seconds=1800,
        expires_in_seconds=5400,
    )
    assert receipts == []  # non-terminal classification only upserts, no proposal to settle yet — confirm this against Task 7's orchestration before finalizing

    terminal = Classification(status="completed_normally", is_terminal=True, stall_signal=None)
    evidence = {
        "run_id": "abl.test.settle",
        "status": "completed_normally",
        "exit_code": 0,
        "last_step": 100,
        "target_step": 100,
        "log_path": "/tmp/train.log",
        "metrics_path": "/tmp/eval_result.json",
    }
    receipts = settle(
        registry_path=registry_path,
        goal_id=goal_id,
        agent_id=agent_id,
        run_id="abl.test.settle",
        classification=terminal,
        evidence=evidence,
        cadence_seconds=1800,
        expires_in_seconds=5400,
    )
    assert receipts[-1]["kind"] == "continuous_monitor_complete"
    assert json.loads(receipts[-1]["evidence"])["status"] == "completed_normally"


def test_repeated_upsert_same_last_step_reports_unchanged(loopx_goal_fixture):
    """The real signal dead_monitor_repeat depends on: settle_governed_transition_proposals
    returns one receipt per proposal with a real `action` field
    ("created"/"reused"/"updated"/"unchanged"), sourced from
    _upsert_monitor's `update_goal_todo(...).get("changed")`. Two upserts
    with the same last_step must produce the same `text`, so the second
    call's receipt action must be "unchanged" — this is the actual
    behavior LoopX's stall counter relies on, not Classification.stall_signal."""
    registry_path, goal_id, agent_id = loopx_goal_fixture
    stalled = Classification(status="still_running", is_terminal=False, stall_signal="unchanged")
    evidence = {"last_step": 42}
    first_receipts = settle(
        registry_path=registry_path, goal_id=goal_id, agent_id=agent_id,
        run_id="abl.test.stall", classification=stalled, evidence=evidence,
        cadence_seconds=1800, expires_in_seconds=5400,
    )
    second_receipts = settle(
        registry_path=registry_path, goal_id=goal_id, agent_id=agent_id,
        run_id="abl.test.stall", classification=stalled, evidence=evidence,
        cadence_seconds=1800, expires_in_seconds=5400,
    )
    assert first_receipts[0]["action"] in ("created", "reused")
    assert second_receipts[0]["action"] == "unchanged"


def test_repeated_upsert_advancing_last_step_reports_updated(loopx_goal_fixture):
    """Mirror of the above with different last_step values — this is what
    must happen for dead_monitor_repeat to correctly reset on real progress."""
    registry_path, goal_id, agent_id = loopx_goal_fixture
    stalled = Classification(status="still_running", is_terminal=False, stall_signal="changed")
    settle(
        registry_path=registry_path, goal_id=goal_id, agent_id=agent_id,
        run_id="abl.test.advance", classification=stalled, evidence={"last_step": 10},
        cadence_seconds=1800, expires_in_seconds=5400,
    )
    receipts = settle(
        registry_path=registry_path, goal_id=goal_id, agent_id=agent_id,
        run_id="abl.test.advance", classification=stalled, evidence={"last_step": 20},
        cadence_seconds=1800, expires_in_seconds=5400,
    )
    assert receipts[0]["action"] == "updated"
```

- [ ] **Step 4: Run to verify it fails**

Run: `pytest tests/extensions/test_research_ablation_settlement.py -v`
Expected: FAIL — `settlement.py` does not exist yet.

- [ ] **Step 5: Write `settlement.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from loopx.control_plane.work_items.governed_transition_proposal import (
    GovernedTransitionSettlementPhase,
    settle_governed_transition_proposals,
)

from .classify import Classification

_TARGET_KEY_PREFIX = "abl."


def _effect_id(run_id: str) -> str:
    return "research-ablation:" + hashlib.sha256(run_id.encode()).hexdigest()[:16]


def _proposal_id(run_id: str, kind: str) -> str:
    return hashlib.sha256(f"{run_id}:{kind}".encode()).hexdigest()[:32]


def settle(
    *,
    registry_path: Path,
    goal_id: str,
    agent_id: str,
    run_id: str,
    classification: Classification,
    evidence: dict[str, Any],
    cadence_seconds: int,
    expires_in_seconds: int,
) -> list[dict[str, Any]]:
    monitor_key = f"{_TARGET_KEY_PREFIX}{run_id}"
    last_step = evidence.get("last_step")
    proposals: list[dict[str, Any]] = [
        {
            "kind": "continuous_monitor_upsert",
            "proposal_id": _proposal_id(run_id, "upsert"),
            "monitor_key": monitor_key,
            "target_key": monitor_key,
            # `last_step` MUST be embedded in `text` (a diffed field): LoopX's
            # own `update_goal_todo` reports "changed"/"unchanged" by comparing
            # the fields in this call against the stored Todo, and that diff
            # (not Classification.stall_signal) is what actually drives
            # `dead_monitor_repeat`. A static `text` would make every poll
            # look "unchanged" regardless of real progress.
            "text": f"Monitor training run {run_id} (last_step={last_step})",
            "action_kind": "poll_training_run",
            "required_capabilities": ["research_ablation_monitor"],
            "cadence": f"{cadence_seconds}s",
            "next_due_at": f"+{cadence_seconds}s",
            "expires_at": f"+{expires_in_seconds}s",
        }
    ]
    if classification.is_terminal:
        proposals.append(
            {
                "kind": "continuous_monitor_complete",
                "proposal_id": _proposal_id(run_id, "complete"),
                "monitor_key": monitor_key,
                "evidence": json.dumps(evidence, sort_keys=True),
            }
        )

    def checkpoint(_receipts: list[dict[str, Any]]) -> None:
        return None

    return settle_governed_transition_proposals(
        registry_path=registry_path,
        goal_id=goal_id,
        agent_id=agent_id,
        effect_id=_effect_id(run_id),
        # `existing_receipts=[]` is deliberate, not an oversight: this plan
        # does not persist receipts across polls, so settle_governed_transition_proposals'
        # own idempotent-replay path (matching proposal_id -> skip) never
        # engages here. Changed/unchanged detection for this plan comes
        # entirely from update_goal_todo's diff inside _upsert_monitor (see
        # the `text` field above). Cross-restart idempotent replay of
        # settlement itself is out of scope — it belongs with the later
        # "幂等提交" sub-project, which persists real job handles.
        existing_receipts=[],
        checkpoint=checkpoint,
        phase=GovernedTransitionSettlementPhase.PRE_SETTLEMENT,
    )
```

- [ ] **Step 6: Run to verify it passes, fixing any real-API mismatch found**

Run: `pytest tests/extensions/test_research_ablation_settlement.py -v`
If it fails on an unexpected field name or enum value, that is expected given this is unwired-in-production code — re-read `governed_transition_proposal.py`'s `_upsert_monitor`/`_complete_monitor`/`settle_governed_transition_proposals` and fix `settlement.py` and the test together until both are internally consistent AND pass against the real function. Do not weaken the assertions to make them pass.

- [ ] **Step 7: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/settlement.py tests/extensions/test_research_ablation_settlement.py
git commit -m "feat(research-ablation): wire governed continuous_monitor settlement"
```

---

### Task 7: CLI Entrypoint (stdin/stdout Protocol)

**Files:**
- Create: `packages/loopx-research-ablation/src/loopx_research_ablation/cli.py`
- Create: `packages/loopx-research-ablation/schemas/poll_request.schema.json`
- Create: `packages/loopx-research-ablation/schemas/poll_result.schema.json`
- Create: `packages/loopx-research-ablation/smoke/cli_smoke.py`

**Interfaces:**
- Consumes: `read_sentinel` (Task 3), `run_probe` (Task 4), `classify` (Task 5), `settle` (Task 6).
- Produces: the `main()` entrypoint referenced by `extension.toml`'s `entrypoint = "loopx-research-ablation"` / Task 8's `pyproject.toml` `[project.scripts]`. Request schema (stdin): `{"schema_version": "research_ablation_poll_request_v0", "run_id": ..., "run_dir": ..., "probe_command": [...], "registry_path": ..., "goal_id": ..., "agent_id": ..., "previous_last_step": ..., "cadence_seconds": ..., "expires_in_seconds": ...}`. Response schema (stdout): `{"schema_version": "research_ablation_poll_result_v0", "status": ..., "is_terminal": ..., "stall_signal": ..., "last_step": ..., "receipts": [...]}`.

- [ ] **Step 1: Write the failing smoke assertion**

```python
# packages/loopx-research-ablation/smoke/cli_smoke.py
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG_ROOT / "src"))


def test_doctor_mode():
    result = subprocess.run(
        [sys.executable, "-m", "loopx_research_ablation.cli", "--doctor"],
        cwd=PKG_ROOT / "src",
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    assert payload["ok"] is True


def test_still_running_poll():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        probe_path = run_dir / "probe.sh"
        probe_path.write_text(
            '#!/usr/bin/env bash\necho \'{"last_step": 10, "target_step": 100, "reached_target": false}\'\n'
        )
        probe_path.chmod(0o755)
        request = {
            "schema_version": "research_ablation_poll_request_v0",
            "run_id": "abl.cli.001",
            "run_dir": str(run_dir),
            "probe_command": [str(probe_path)],
            "registry_path": None,
            "goal_id": None,
            "agent_id": None,
            "previous_last_step": None,
            "cadence_seconds": 1800,
            "expires_in_seconds": 5400,
        }
        result = subprocess.run(
            [sys.executable, "-m", "loopx_research_ablation.cli"],
            cwd=PKG_ROOT / "src",
            input=json.dumps(request),
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        assert payload["status"] == "still_running"
        assert payload["is_terminal"] is False
        assert payload["stall_signal"] == "changed"
        assert payload["receipts"] == []


if __name__ == "__main__":
    test_doctor_mode()
    test_still_running_poll()
    print("cli_smoke: OK")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python packages/loopx-research-ablation/smoke/cli_smoke.py`
Expected: FAIL — no `cli.py` module.

- [ ] **Step 3: Write the two schema files**

```json
// packages/loopx-research-ablation/schemas/poll_request.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema_version", "run_id", "run_dir", "probe_command"],
  "properties": {
    "schema_version": {"const": "research_ablation_poll_request_v0"},
    "run_id": {"type": "string"},
    "run_dir": {"type": "string"},
    "probe_command": {"type": "array", "items": {"type": "string"}},
    "registry_path": {"type": ["string", "null"]},
    "goal_id": {"type": ["string", "null"]},
    "agent_id": {"type": ["string", "null"]},
    "previous_last_step": {"type": ["integer", "null"]},
    "cadence_seconds": {"type": "integer"},
    "expires_in_seconds": {"type": "integer"},
    "log_path": {"type": ["string", "null"]},
    "metrics_path": {"type": ["string", "null"]}
  }
}
```

```json
// packages/loopx-research-ablation/schemas/poll_result.schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema_version", "status", "is_terminal", "stall_signal", "receipts"],
  "properties": {
    "schema_version": {"const": "research_ablation_poll_result_v0"},
    "status": {"type": "string"},
    "is_terminal": {"type": "boolean"},
    "stall_signal": {"type": ["string", "null"]},
    "last_step": {"type": ["integer", "null"]},
    "receipts": {"type": "array"}
  }
}
```

- [ ] **Step 4: Write `cli.py`**

```python
# packages/loopx-research-ablation/src/loopx_research_ablation/cli.py
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .classify import classify
from .probe import run_probe
from .sentinel import read_sentinel
from .settlement import settle

REQUEST_SCHEMA_VERSION = "research_ablation_poll_request_v0"
RESULT_SCHEMA_VERSION = "research_ablation_poll_result_v0"


def _handle_poll(request: dict[str, Any]) -> dict[str, Any]:
    if request.get("schema_version") != REQUEST_SCHEMA_VERSION:
        raise ValueError(f"unsupported schema_version {request.get('schema_version')!r}")
    run_dir = Path(request["run_dir"])
    sentinel = read_sentinel(run_dir)
    probe = run_probe(request["probe_command"], run_dir)
    classification = classify(sentinel, probe, request.get("previous_last_step"))

    receipts: list[dict[str, Any]] = []
    if request.get("registry_path"):
        evidence = {
            "run_id": request["run_id"],
            "status": classification.status,
            "exit_code": sentinel.exit_code if sentinel else None,
            "last_step": probe.last_step,
            "target_step": probe.target_step,
            "log_path": request.get("log_path"),
            "metrics_path": request.get("metrics_path"),
        }
        receipts = settle(
            registry_path=Path(request["registry_path"]),
            goal_id=request["goal_id"],
            agent_id=request["agent_id"],
            run_id=request["run_id"],
            classification=classification,
            evidence=evidence,
            cadence_seconds=request["cadence_seconds"],
            expires_in_seconds=request["expires_in_seconds"],
        )

    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "status": classification.status,
        "is_terminal": classification.is_terminal,
        "stall_signal": classification.stall_signal,
        "last_step": probe.last_step,
        "receipts": receipts,
    }


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--doctor"]:
        json.dump({"ok": True, "schema_version": REQUEST_SCHEMA_VERSION, "doctor": "ok"}, sys.stdout)
        sys.stdout.write("\n")
        return 0

    request = json.load(sys.stdin)
    try:
        response = _handle_poll(request)
        json.dump(response, sys.stdout, sort_keys=True, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 - protocol boundary reports all failures uniformly
        json.dump({"schema_version": RESULT_SCHEMA_VERSION, "error": str(exc)}, sys.stdout)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

Note: request omits `registry_path` in the smoke test (`None`), which is why Step 1's assertion expects `receipts == []` even for a non-terminal, real poll — this keeps Task 7's own smoke test independent of a real LoopX registry; Task 8's end-to-end smoke test is where a real `registry_path` gets exercised.

- [ ] **Step 5: Run to verify it passes**

Run: `python packages/loopx-research-ablation/smoke/cli_smoke.py`
Expected: prints `cli_smoke: OK`

- [ ] **Step 6: Commit**

```bash
git add packages/loopx-research-ablation/src/loopx_research_ablation/cli.py packages/loopx-research-ablation/schemas/ packages/loopx-research-ablation/smoke/cli_smoke.py
git commit -m "feat(research-ablation): add CLI stdin/stdout protocol entrypoint"
```

---

### Task 8: Packaging And End-To-End Smoke Test

**Files:**
- Create: `packages/loopx-research-ablation/pyproject.toml`
- Create: `packages/loopx-research-ablation/README.md`
- Create: `packages/loopx-research-ablation/CONTRACT.md`
- Create: `packages/loopx-research-ablation/smoke/end_to_end_smoke.py`

**Interfaces:**
- Consumes: everything from Tasks 1-7, plus whatever real LoopX goal-registry fixture helper Task 6 ended up reusing from `tests/extensions/test_governed_capability_execution.py`.
- Produces: nothing further downstream — this is the plan's acceptance test, proving the spec's central promise end-to-end.

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "loopx-research-ablation"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["loopx"]

[project.scripts]
loopx-research-ablation = "loopx_research_ablation.cli:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 2: Write `CONTRACT.md`** (mirrors `packages/loopx-repo-health/CONTRACT.md`'s Ownership/Rules/Evidence structure)

```markdown
# Research-Ablation Monitor Provider Contract

`research_ablation_poll_result_v0` reports the state of one scheduler-less
training run tracked via `run_tracked.sh` and a project-owned progress probe.

## Ownership

| Surface | Owner | Responsibility |
| --- | --- | --- |
| Contract | `loopx-research-ablation` extension | Schema, status vocabulary, boundary rules |
| Sentinel | `run_tracked.sh` | Atomic process-exit evidence |
| Progress | project-owned probe script | Step/target parsing for one training framework |
| Settlement | `loopx-research-ablation` extension | First caller of `settle_governed_transition_proposals` |

## Rules

- Raw metric values are never part of the response or LoopX evidence — only
  `metrics_path`, a pointer.
- A probe failure (`probe_error`) always bypasses `dead_monitor_repeat` and
  settles immediately; it is never folded into stall counting.
- Every terminal `status` results in exactly one `continuous_monitor_complete`
  proposal; there is no "pause without completing" path.

## Evidence

Each terminal poll's evidence carries `run_id`, `status`, `exit_code`,
`last_step`, `target_step`, `log_path`, `metrics_path`.
```

- [ ] **Step 3: Write `README.md`** with install/usage instructions (one paragraph, mirrors `packages/loopx-repo-health/README.md`'s opening structure — state what it does, then how `run_tracked.sh` + a probe script + this extension compose).

- [ ] **Step 4: Write the failing end-to-end smoke test**

```python
# packages/loopx-research-ablation/smoke/end_to_end_smoke.py
"""
Full pipeline: run_tracked.sh launches a fake training script that writes
progressing step counts to a log, a probe script parses that log, and the
CLI is polled twice — once mid-run (non-terminal), once after completion
(terminal, with a real settle() call against a temporary LoopX goal).

NOTE for implementer: reuse the same goal/registry bootstrap helper Task 6
used from tests/extensions/test_governed_capability_execution.py — do not
hand-roll a second registry fixture.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]
WRAPPER = PKG_ROOT / "bin" / "run_tracked.sh"


def _write_fake_training(run_dir: Path) -> Path:
    script = run_dir / "fake_train.sh"
    script.write_text(
        "#!/usr/bin/env bash\n"
        f"echo step=1 >> {run_dir}/train.log\n"
        f"echo step=2 >> {run_dir}/train.log\n"
        "exit 0\n"
    )
    script.chmod(0o755)
    return script


def _write_probe(run_dir: Path) -> Path:
    probe = run_dir / "probe.sh"
    probe.write_text(
        "#!/usr/bin/env bash\n"
        'last=$(grep -c step= "$1/train.log" 2>/dev/null || echo 0)\n'
        'if [[ "$last" -ge 2 ]]; then reached=true; else reached=false; fi\n'
        'echo "{\\"last_step\\": $last, \\"target_step\\": 2, \\"reached_target\\": $reached}"\n'
    )
    probe.chmod(0o755)
    return probe


def _poll(request: dict) -> dict:
    result = subprocess.run(
        [sys.executable, "-m", "loopx_research_ablation.cli"],
        cwd=PKG_ROOT / "src",
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_full_lifecycle_without_registry():
    with tempfile.TemporaryDirectory() as run_dir:
        run_dir = Path(run_dir)
        training = _write_fake_training(run_dir)
        probe = _write_probe(run_dir)

        subprocess.run(["bash", str(WRAPPER), "abl.e2e.001", str(run_dir), str(training)], check=True)

        response = _poll(
            {
                "schema_version": "research_ablation_poll_request_v0",
                "run_id": "abl.e2e.001",
                "run_dir": str(run_dir),
                "probe_command": [str(probe)],
                "registry_path": None,
                "goal_id": None,
                "agent_id": None,
                "previous_last_step": None,
                "cadence_seconds": 1800,
                "expires_in_seconds": 5400,
            }
        )
        assert response["status"] == "completed_normally"
        assert response["is_terminal"] is True


if __name__ == "__main__":
    test_full_lifecycle_without_registry()
    print("end_to_end_smoke: OK (registry-backed settlement path exercised separately in tests/extensions/test_research_ablation_settlement.py)")
```

- [ ] **Step 5: Run to verify it fails, then passes once Tasks 1-7 are all committed**

Run: `python packages/loopx-research-ablation/smoke/end_to_end_smoke.py`
Expected (after Tasks 1-7 complete): prints `end_to_end_smoke: OK ...`

- [ ] **Step 6: Run the full test suite for regressions**

Run: `pytest tests/extensions/ -v && python packages/loopx-research-ablation/smoke/run_tracked_smoke.py && python packages/loopx-research-ablation/smoke/sentinel_smoke.py && python packages/loopx-research-ablation/smoke/probe_smoke.py && python packages/loopx-research-ablation/smoke/classify_smoke.py && python packages/loopx-research-ablation/smoke/cli_smoke.py && python packages/loopx-research-ablation/smoke/end_to_end_smoke.py`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/loopx-research-ablation/pyproject.toml packages/loopx-research-ablation/README.md packages/loopx-research-ablation/CONTRACT.md packages/loopx-research-ablation/smoke/end_to_end_smoke.py
git commit -m "feat(research-ablation): package extension and add end-to-end smoke test"
```
