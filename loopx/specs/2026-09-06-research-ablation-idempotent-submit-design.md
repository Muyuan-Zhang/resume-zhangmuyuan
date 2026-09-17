# 提交前幂等检查设计

## 目标

让host在真正提交一次训练任务（调用`run_tracked.sh`）之前，能查询"这个`run_id`是否已经被LoopX追踪过"，避免host进程崩溃重启后误判"要重新开始"而重复提交一次真实的、GPU天级别成本的训练任务。这是"LoopX改造成科研消融流水线"项目里的第四个可落地子项目。

## 范围

这次改动会：

- 把训练监控扩展（`settlement.py`）里已有的私有函数`_monitor_key(run_id)`和`_existing_monitor(*, registry_path, goal_id, monitor_key)`重构挪到一个新的共享模块`monitor_lookup.py`，去掉下划线前缀变成公开函数（`monitor_key()`/`existing_monitor()`），`settlement.py`改为从这个新模块import，而不是自己定义；
- 新增`loopx-research-ablation-check-before-submit` CLI，host在调用`run_tracked.sh`之前先跑这个命令；
- 定义三态输出：`no_prior_attempt`（没查到，可以放心提交）、`already_tracked_open`（已经在追踪且未完成，不该重新提交，应直接开始/继续轮询这个已有run_id）、`already_tracked_done`（这个run_id已经走完，重新提交没有意义）；
- 退出码约定：这个CLI本身**永远退出0**（除非真的执行出错，比如`--registry-path`指向的路径不存在），三种状态都算"检查成功执行"，决策放在JSON的`status`字段里——这跟`list-attempts`的退出码约定一致，跟`validate_cli.py`不一致（那边退出码本身就是pass/fail判定，因为要喂给LoopX的`validation_command`硬阻塞机制）。

这次改动**不会**：

- 做"集群上真的在跑但LoopX这边没有记录"这种反向对账——这是⑧号子项目"孤儿任务对账深化"的范围，本设计只处理"以LoopX这边的记录为准，判断要不要提交"这一个方向；
- 实现"`already_tracked_done`状态下自动生成新run_id重新开始"的逻辑——这个决策和执行动作是host自己的责任，CLI只负责报告事实，不替host做决定；
- 触碰LoopX核心todo schema；
- 写正式的SKILL.md操作手册（⑩号子项目负责把"提交前必须先调用这个CLI"这条强制指令写进正式文档，本设计只保证CLI接口本身可用，不依赖SKILL.md也能被单独调用）。

## 归属与落位

- `monitor_lookup.py`和新CLI（`check_before_submit_cli.py`）都放进已有的`packages/loopx-research-ablation/`包里，跟这个包的其他能力（训练监控、benchmark验证、查重台账）共享同一套结构。
- `monitor_lookup.py`是这次重构唯一触碰到已上线代码（`settlement.py`）的地方——变动仅限于把两个函数搬家、去掉下划线前缀，不改变它们的行为，`settlement.py`已有的测试（`tests/extensions/test_research_ablation_settlement.py`）在这次改动后必须继续全部通过，不允许因为搬家改变任何返回值或参数顺序。

## CLI接口

```
loopx-research-ablation-check-before-submit --run-id <id> --registry-path <path> --goal-id <id>
```

输出（stdout一行JSON）：

```json
{"status": "no_prior_attempt", "monitor_key": "ablmon:r-abc123", "todo_status": null}
```

- `status`：三态之一（见上）。
- `monitor_key`：由`monitor_lookup.monitor_key(run_id)`计算得到，供host自己诊断/日志使用。
- `todo_status`：`null`（对应`no_prior_attempt`）或LoopX todo的真实状态字符串（`"open"`/`"done"`，对应另外两种`status`）。

错误路径（`--registry-path`不存在、`--goal-id`格式非法等）：打印`validation error: ...`到stderr，退出码1——这是执行本身失败，跟三态查询结果的"退出码永远0"约定不冲突（三态是查询成功后的结果，执行失败是另一回事）。

**关于`--agent-id`**：计划阶段发现`existing_monitor()`（从settlement.py搬来的查询函数）底层调用`list_goal_todos`时根本不需要`agent_id`，所以这个CLI不声明`--agent-id`参数，避免一个没有实际作用的死参数。

## 明确推迟的部分

- 反向孤儿任务对账（集群侧真实运行但LoopX无记录的情况）——⑧号子项目。
- 自动生成新run_id的策略/命名规则。
- 正式SKILL.md操作手册里"提交前必须调用此CLI"这条强制指令的具体措辞——⑩号子项目。
