# 孤儿任务对账设计

## 目标

发现"训练任务真实运行过/完成过，但LoopX完全没有对应记录"的情况——这是⑦号子项目（提交前幂等检查）没有覆盖的反方向：⑦解决"LoopX有记录，该不该信"，⑧解决"LoopX没记录，是不是漏了什么"。这是"LoopX改造成科研消融流水线"项目里的第五个可落地子项目。

## 前置依赖（重要，影响实施顺序）

本设计依赖⑨号查重台账（`.loopx-research-ablation/attempts.jsonl`）的记录schema里加一个`run_dir`字段（记录这次尝试打算/已经把训练放在哪个目录）——没有这个字段，对账工具根本不知道去哪个目录找哨兵文件。⑨的spec（`2026-09-06-research-ablation-dedup-design.md`）和已写好但未实施的plan都需要先做一次小修订加上这个字段和对应的`--run-dir`必填参数，**这个修订必须在⑧实施之前完成并实施**——⑧不是⑨的平行子项目，是⑨的下游。

## 范围

这次改动会：

- 修订⑨号spec和plan：`attempts.jsonl`记录schema新增`run_dir`字段；`loopx-research-ablation-log-attempt` CLI新增`--run-dir <path>`必填参数（跟`--dedup-check`一样，缺省即报错，因为对账依赖这个字段是刚需，不是锦上添花）；
- 新增`loopx-research-ablation-reconcile` CLI，扫描账本里的每条记录，交叉核对LoopX侧（`monitor_lookup.existing_monitor()`）和文件系统侧（`run_dir`是否存在、`sentinel.read_sentinel()`是否读到哨兵）两个独立信号；
- 定义四态分类：`consistent`（LoopX有记录，一切正常）、`orphan_completed_untracked`（LoopX没记录但哨兵显示训练真的跑完了——最值得关注）、`orphan_unknown_state`（LoopX没记录、run_dir存在但没哨兵——文件层面判断不了，需要人工用`ps`/`nvidia-smi`确认）、`missing_run_dir`（LoopX没记录、run_dir在磁盘上也不存在——纯粹的死记录，无可恢复）；
- 默认只打印非`consistent`的记录（避免正常记录刷屏），`--all`看全部，`--run-id`只查一条；
- 退出码约定：永远0（除非执行本身出错，如`--registry-path`不存在）——决策信息在JSON里，跟`list-attempts`/`check-before-submit`一致，不是pass/fail判定。

这次改动**不会**：

- 自动"修复"孤儿——不自动把发现的孤儿注册进LoopX的monitor状态、不自动kill疑似还在跑的进程，工具只报告事实，怎么处理是host/研究者自己的决定；
- 做实时/自动触发的对账（比如接进每次轮询周期）——按我们的一贯原则，工具不做自主daemon，这是纯手动按需执行的CLI；
- 触碰LoopX核心todo schema；
- 写正式的SKILL.md操作手册（⑩号子项目负责把"多久该手动跑一次对账"这类操作指引写清楚）。

## 归属与落位

新增的`reconcile_cli.py`放进同一个包`packages/loopx-research-ablation/`，复用⑦已经抽出来的`monitor_lookup.py`和⑨的`attempts_ledger.py`读取逻辑，以及训练监控扩展自己的`sentinel.py`（`read_sentinel`函数直接复用，不重新实现哨兵解析）。

## CLI接口

```
loopx-research-ablation-reconcile --registry-path <path> --goal-id <id> [--ledger-path <path>] [--run-id <id>] [--all]
```

输出（每条一行JSON，默认只输出`flag != "consistent"`的记录，`--all`输出全部）：

```json
{"run_id": "abl.moe-topk2.20260906-1430", "run_dir": "/data/runs/abl.moe-topk2.20260906-1430", "monitor_status": "not_found", "sentinel_status": "present", "run_dir_exists": true, "flag": "orphan_completed_untracked"}
```

- `monitor_status`：`"not_found"`/`"open"`/`"done"`（来自`existing_monitor()`查到的LoopX todo状态，查不到就是`"not_found"`）。
- `sentinel_status`：`"not_found"`/`"present"`（来自`read_sentinel(run_dir)`，`run_dir`不存在时视为`"not_found"`，不单独报错）。
- `run_dir_exists`：布尔值，独立于`sentinel_status`报告，因为"目录都没了"和"目录在但没哨兵"是两种不同严重程度的情况。
- `flag`：四态之一，见上。

`--run-id`只对账本里这一条记录做检查（不需要`--all`也会输出，因为明确指定了目标）；两者互斥使用即可，不强制校验互斥（同时传都传的话`--run-id`优先）。

## 四态分类表

| LoopX有记录 | run_dir存在 | 哨兵存在 | flag |
|---|---|---|---|
| 有（open或done） | - | - | `consistent` |
| 没有 | 存在 | 有 | `orphan_completed_untracked` |
| 没有 | 存在 | 没有 | `orphan_unknown_state` |
| 没有 | 不存在 | - | `missing_run_dir` |

## 明确推迟的部分

- 自动修复/自动处理孤儿（自动注册进LoopX、自动kill进程）。
- 自动化/周期性触发对账（daemon式）。
- 正式SKILL.md操作手册里"多久该手动跑一次"这类操作指引——⑩号子项目。
