# 科研消融训练监控扩展设计

## 目标

让host agent（Claude Code、Codex、dsh等）能可靠地在LoopX之下发起一次长时间（GPU小时级到GPU天级）的消融训练任务，在**没有任何任务调度器API**的情况下检测训练是完成了还是崩了，并让LoopX在训练结束后自动把结果转成一个独立的推进型todo交还给host——host不需要手动去轮询shell或者盯着tmux会话。

这是"把LoopX改造成科研消融流水线"这个大项目里第一个可落地的子项目。范围只覆盖：**把一次外部训练任务跟踪到结束，并把结果具象化成受治理的todo状态**。不包括判断结果好不好（另一个`validation_command`设计）、跟历史架构做查重去重、以及多分支并行运行。

## 范围

这次改动会：

- 新增一个LoopX扩展包 `loopx-research-ablation`，沿用 `packages/loopx-repo-health` 那套现成的 `extension.toml`/`CONTRACT.md`/`schemas/` 目录结构；
- 提供一个 `run_tracked.sh` 包装脚本，把用户真实的训练命令当子进程跑，进程退出时原子性地写一个哨兵文件——不管这个wrapper本身是被套在`nohup`里还是跑在`tmux`会话里；
- 定义一个 `run_id` 令牌格式，同时充当受治理的 `monitor_key`/`target_key`；
- 定义一份JSON协议，给用户自己为每个项目写的**进度探针**脚本用（扩展每次轮询时调用它，扩展本身不解析训练日志）；
- 调用扩展的 `continuous_monitor_upsert`/`continuous_monitor_complete` 操作，把训练任务的生命周期表达成一个受治理的监控型todo，靠LoopX已有的 `external_wait_contract` 机制自动派生出后续的推进型todo；
- 把探针给出的"进度有没有推进"信号，接到LoopX原生的 `dead_monitor_repeat` 卡死计数器上，而不是自己另造一个计数器；
- 定义完成时写入的 `evidence` 载荷schema，以及一组终态状态（`completed_normally`、`crashed_early`、`killed`、`completed_unverified`、`sentinel_missing_but_log_complete`、`probe_error`）。

这次改动**不会**：

- 在扩展内部解析任何具体训练框架的日志格式；
- 判断一次跑完的训练指标够不够好、该不该保留（这是`validation_command`子项目的事）；
- 实现架构标签的查重/去重、或者run history的检索约定；
- 支持同一个goal下多个并发分支（本子项目只支持单个goal同一时间跑一个run；并行分支是明确推迟、甚至可能整个跳过的后续子项目）；
- 触碰LoopX核心的todo元数据schema（`loopx/control_plane/todos/contract.py`里的`_TODO_METADATA_FIELD_SCHEMA`）——这里的一切都骑在LoopX现成的受治理扩展接口上。

## 归属与落位

- 能力产出：观察一个没有调度器、生命周期由裸进程决定的外部训练任务，把它的结局具象化成LoopX的todo状态。
- 能力归属：新扩展，不属于LoopX核心。
- 提供者：`packages/loopx-research-ablation/`——新包，照抄`packages/loopx-repo-health/`的结构（`extension.toml`、`CONTRACT.md`、`pyproject.toml`、`schemas/request.schema.json`、`schemas/response.schema.json`、`src/loopx_research_ablation/`、`smoke/`、`examples/`）。
- `run_tracked.sh` 放在这个包内部（`src/loopx_research_ablation/scripts/run_tracked.sh`），不依赖LoopX，可以独立调用。
- 进度探针脚本**不属于**这个包——它是研究者自己针对每种训练框架写一次的项目侧胶水代码。扩展只知道它的路径（在`continuous_monitor_upsert`时声明）和它的输出协议。
- 声明的权限：`external_write`，且严格限定在`continuous_monitor_upsert`和`continuous_monitor_complete`这两个操作上，不申请任何其他写权限。

## 架构与数据流

```
host agent
  │ 生成 run_id，发起训练
  ▼
run_tracked.sh <run_id> <真实训练命令...>   （外面套nohup还是tmux，host自己决定）
  │ 子进程退出时（正常退出或收到信号）：原子写哨兵文件
  ▼
host agent 调用扩展：continuous_monitor_upsert(run_id, cadence, ...)
  │
  ▼ （由LoopX调度器按cadence唤醒扩展轮询——不是扩展自己起一个常驻daemon）
扩展轮询逻辑：
  1. 读哨兵文件（可能还不存在）
  2. 调用用户的 progress_probe.sh <run_dir> -> {last_step, target_step, reached_target}
  3. 分类：
       哨兵不存在，探针显示有推进        -> 汇报"有变化"（dead_monitor_repeat计数重置）
       哨兵不存在，探针显示无推进        -> 汇报"无变化"（dead_monitor_repeat计数累加）
       哨兵不存在，探针显示已经跑完了    -> status=sentinel_missing_but_log_complete，立即升级
       探针报错/输出不是合法JSON         -> status=probe_error，立即升级（不等卡死计数）
       哨兵存在，reached_target=true     -> status=completed_normally
       哨兵存在，reached_target=false    -> status=crashed_early 或 killed（取决于是否为信号终止）
       哨兵存在，探针读不了/验证不了      -> status=completed_unverified，升级
  4. 任何终态：调用 continuous_monitor_complete(run_id, evidence=<见下方schema>)
  ▼
LoopX 原生的 external_wait_contract 在监控完成时触发
  ▼
一个新的推进型todo被具象化出来，交给host处理
```

## 数据格式

**`run_id`**：只允许小写字母/数字/`.`/`-`（必须满足扩展框架对公开安全令牌的约束），例如 `abl.moe-topk2.20260906-1430`。同时兼任 `monitor_key`/`target_key`。

**哨兵文件**（`<run_dir>/.loopx_sentinel.json`），由 `run_tracked.sh` 通过"先写临时文件再rename"的方式原子写入：
```json
{"run_id": "...", "exit_code": 0, "signal": null, "finished_at": "2026-09-06T14:30:00Z", "pid": 12345}
```
`signal` 只有在wrapper的trap捕获到终止信号时才非空（对应`killed`）；否则状态由`exit_code`加上探针的`reached_target`共同决定。

**进度探针协议**（项目自己拥有的脚本，路径按goal各自声明）：
```
progress_probe.sh <run_dir>  ->  标准输出: {"last_step": 8400, "target_step": 10000, "reached_target": false}
```
任何非零退出码或无法解析的输出都算探针失败，归为 `probe_error`——**绝不**并入"有变化/无变化"的卡死计数。

**完成时写入的evidence**（在 `continuous_monitor_complete` 时写入）：
```json
{
  "run_id": "abl.moe-topk2.20260906-1430",
  "status": "completed_normally",
  "exit_code": 0,
  "last_step": 10000,
  "target_step": 10000,
  "log_path": "/path/to/train.log",
  "metrics_path": "/path/to/eval_result.json"
}
```
真实的指标数值从不直接塞进这里——只存一个指向指标产出文件的路径指针，这跟"LoopX账本保持轻量"的原则一致。真正去读这个文件、判断结果好不好，超出本设计范围（属于`validation_command`子项目）。

## 调度节奏与卡死检测

- `cadence`在`upsert`时根据host提供的"预计跑多久"这个粗略提示来设定，目标是整个训练周期内大概轮询10~20次。
- `expires_at`设为预计时长的1.5倍左右，作为一个跟卡死计数无关的绝对时间兜底上限。
- 卡死检测直接复用LoopX原生的`dead_monitor_repeat`计数器，不另造一个：每次轮询的"有变化/无变化"完全取决于探针的`last_step`相比上一次有没有推进。`probe_error`和`sentinel_missing_but_log_complete`完全绕开这个计数器直接升级，因为它们是工具层面的异常，不是"训练进展合理但慢"的正常情况。
- 同一个`run_id`被两个host同时upsert的并发竞态，已经被扩展框架自带的受治理转换机制处理过了（`_upsert_monitor`里的owner冲突检查）——这里不需要再设计额外的加锁。

## 错误处理

| 情况 | 检测方式 | 结果状态 | 是否立即升级 |
|---|---|---|---|
| 忘了用wrapper | 哨兵一直不出现 + 探针显示`reached_target: true` | `sentinel_missing_but_log_complete` | 是 |
| 探针脚本报错/输出非法JSON | 非零退出或解析失败 | `probe_error` | 是（不等卡死计数） |
| 哨兵存在，但log读不了 | 探针在进程退出后无法运行/读取 | `completed_unverified` | 是 |
| 进程被手动kill | 哨兵的`signal`字段被设置 | `killed` | 否（正常终态路径） |
| 未到目标step就自然崩溃 | 哨兵存在，`reached_target: false`，无信号 | `crashed_early` | 否（正常终态路径） |
| 正常完成 | 哨兵存在，`reached_target: true` | `completed_normally` | 否（正常终态路径） |
| 训练真的卡死了 | `dead_monitor_repeat`阈值（6次）达到 | LoopX原生的`autonomous_replan_required` | 是，通过LoopX既有机制 |

除"训练真的卡死了"之外，每一行最终都会调用`continuous_monitor_complete`——本设计里没有"暂停但不完成"这条单独路径。"是否立即升级"这一列区分的是：哪些行绕开了`dead_monitor_repeat`计数器、一发生就立刻触发（工具层异常：忘用wrapper、探针坏了、log读不了），跟另外三种普通终态结果（`killed`、`crashed_early`、`completed_normally`）——它们不是异常，只是走正常方式完成监控。所有会完成监控的情况，host都会被同一套`external_wait_contract`派生出的推进型todo唤醒；evidence里的`status`字段负责告诉host这次是要去判断指标，还是要去排查失败原因。

## 明确推迟的部分

- 根据`metrics_path`判断结果是否达标（`validation_command`设计）。
- 架构标签的schema和run history查重检索约定。
- 并行分支/多goal协调。
- 把所有子项目整合起来的正式`SKILL.md`操作手册。
