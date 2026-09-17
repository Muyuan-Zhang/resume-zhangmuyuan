# 消融尝试查重台账设计

## 目标

让host agent在提案一次新的消融改动（+A/+B/+C）之前，能够查询过去所有尝试过的架构来源/技术变体/超参数，判断这次提案是否在重复一个已经试过的东西——避免在GPU天级别的训练成本上重复造轮子。这是"LoopX改造成科研消融流水线"这个大项目里的第三个可落地子项目（在训练监控扩展、benchmark自动判定之后）。

## 范围

这次改动会：

- 新增一个追加式旁路账本 `.loopx-research-ablation/attempts.jsonl`（研究者项目仓库自己的文件，跟已有的 `.loopx-research-ablation/benchmark.json` 同一约定目录下），一行一条JSON记录，每条对应一次消融尝试；
- 定义账本记录的schema：`run_id`/`run_dir`（这次尝试打算/已经把训练放在哪个目录）/`source`（论文/文章出处）/`technique`（具体实现变体标签）/`hyperparameters`（结构性超参数变化，自由key-value）/`description`（自由文本）/`created_at`/`status`（这次尝试的结局，默认`pending`）；
- 新增 `loopx-research-ablation-log-attempt` CLI：host发起新尝试时调用，写一行记录进账本；**`--dedup-check`是必填参数**（值为`"none"`或逗号分隔的相关run_id列表），不传直接报错拒绝写入；
- 新增 `loopx-research-ablation-list-attempts` CLI：host提案前查询用，按`--source-contains`/`--technique`过滤，打印匹配记录（含完整description）供host自己判断相似度；
- 两个CLI都放进已有的 `packages/loopx-research-ablation/` 包里，跟训练监控扩展、benchmark验证共享同一个包。

这次改动**不会**：

- 自动判断两次尝试"像不像"——这需要语义理解，是host自己的责任，我们反复确认过这一点做不了也不该做；
- 对`hyperparameters`做数值相似度搜索或阈值判断——只做存储和原样展示，不做智能比较；
- 把这条账本自动接入训练监控扩展的`continuous_monitor`生命周期——两者是各自独立的旁路文件机制，`status`字段的自动回填（训练完成/benchmark判定后自动更新账本状态）留给后续子项目，本设计只声明schema里有这个字段，回填先靠host手动调用（或未来一个专门的整合子项目）；
- 触碰LoopX核心todo schema；
- 写正式的SKILL.md操作手册（那是⑩号子项目，本设计只保证CLI接口本身把"必须声明查过"这件事锁死，不依赖SKILL.md也生效）。

## 归属与落位

- 提供者：仍然是 `packages/loopx-research-ablation/`，不新建包——`src/loopx_research_ablation/attempts_ledger.py`（读写账本的核心逻辑）+ `log_attempt_cli.py` + `list_attempts_cli.py`（两个独立CLI入口）。
- 账本文件的归属：研究者的项目仓库，不是这个扩展包自己的目录——跟benchmark.json一样，靠"CLI运行时cwd就是项目工作区"这个既有约定被发现，不需要显式传路径（但保留`--ledger-path`覆盖选项，供测试和非常规布局使用）。

## 数据格式

**账本文件**：`.loopx-research-ablation/attempts.jsonl`，追加式，一行一个JSON对象：

```json
{"run_id": "abl.moe-topk2.20260906-1430", "run_dir": "/data/runs/abl.moe-topk2.20260906-1430", "source": "Switch Transformer (Fedus et al. 2021)", "technique": "moe-topk2-routing", "hyperparameters": {"num_experts": 8, "topk": 2}, "description": "在FFN层用MoE替换baseline，topk=2专家数8个，想验证能否在不显著增加计算量的情况下提升容量", "created_at": "2026-09-06T14:30:00Z", "status": "pending", "dedup_check": "none"}
```

字段说明：

- `run_id`：跟训练监控扩展的`run_id`是同一个值，两套旁路机制通过这个字段间接关联（不强制耦合，允许账本里出现监控扩展还不知道的run_id，比如提案了但还没真正提交训练）。
- `run_dir`：这次尝试打算/已经把训练放在哪个目录的绝对路径，**必填**（跟`dedup_check`一样不可省略）——⑧号子项目"孤儿任务对账"依赖这个字段去文件系统层面核实训练是否真的跑过，没有这个字段对账无从谈起。
- `source`：论文/文章出处的自由文本，是最强的粗筛信号。
- `technique`：具体实现变体标签的自由文本（如`"unet"`/`"vit"`/`"moe-topk2-routing"`）。
- `hyperparameters`：自由的flat key-value数值对象，不做schema校验（研究者自己决定记哪些维度）；`--hyperparameters`参数可省略，省略时账本里存`{}`。
- `description`：自由文本，供host读取判断相似度用。
- `status`：`"pending"`（默认）或后续手动回填的任意值（如`"completed_normally"`/`"kept"`/`"discarded"`）——本设计不校验这个字段的取值范围，因为它的更新时机和权威来源属于后续子项目。
- `dedup_check`：`"none"`或逗号分隔的run_id列表，写入时由`--dedup-check`参数决定，不可省略。

## `log-attempt` CLI

```
loopx-research-ablation-log-attempt --run-id <str> --run-dir <path> --source <str> --technique <str> \
  [--hyperparameters '<JSON对象>'] --description <str> --dedup-check <"none"|"id1,id2,..."> \
  [--ledger-path <path>]
```

- 缺少`--dedup-check`：CLI打印错误信息到stderr，退出码1，不追加任何记录——这是强制声明机制的核心，把"要不要查重"从可以悄悄跳过的良心活变成必须显式留痕的一步，即使不验证host是否认真查过。
- `--run-dir`同样必填，缺省同样报错退出码1、不写入——理由跟`--dedup-check`一样，是⑧号对账工具的刚需字段，不是锦上添花的可选项。
- `--dedup-check`传的run_id不需要校验是否真实存在于账本里（不做交叉校验——如果host打错了id，账本里留的痕迹本身就是审计线索，事后能发现"host老是引用不存在的id"这类异常模式，不需要CLI替它把关）。
- 写入必须是追加（append-only），不允许修改/删除已有行——这是账本，不是可变状态。

## `list-attempts` CLI

```
loopx-research-ablation-list-attempts [--source-contains <str>] [--technique <str>] [--ledger-path <path>]
```

- 不传任何过滤参数时列出全部记录。
- `--source-contains`：子串匹配（大小写不敏感），`--technique`：精确匹配。
- 两个过滤条件可以同时传，取交集。
- 输出：每条匹配记录的完整JSON（含description），按`created_at`升序打印，人类和host都直接可读。

## 明确推迟的部分

- 把账本`status`字段跟训练监控扩展的完成事件自动关联/回填。
- 正式的SKILL.md操作手册（⑩号子项目），把"每次提案前必须先list再log"这个强制指令写清楚。
- 任何形式的语义相似度/embedding检索——这条线一旦要做，走的是完全不同的技术路径（参照前面讨论过的AI Scientist式文献查重、NAS式代理模型），不是这个子项目的范围。
