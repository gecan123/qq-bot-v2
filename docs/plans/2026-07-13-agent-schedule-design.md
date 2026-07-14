# Agent 短期调度设计

## 目标

把现有一次性 `schedule` 升级成 Luna 在未来三天内重新驱动自己的统一入口。它支持一次性时间、固定间隔和 cron 墙上时间；到期只向单一 `BotLoopAgent` 注入注意事件，由 Agent 结合最新消息、Goal 和外部状态重新判断下一步。

这个能力用于数分钟到数天的复查、阶段性实验和短期例行活动，不引入第二个 Agent loop，也不持久化未来工具调用。

## 决策背景

当前能力有三个相邻但不同的边界：

- `pause` 负责眼下 30–600 秒的自然休息。
- `todo` 负责当前进程内已经决定执行的多步清单。
- `goal` 负责跨轮、跨重启的长期主线和完成标准。

现有 `schedule` 只接受 30 秒到 7 天的相对延迟，创建一个一次性 durable wake。仓库运行日志和持久任务状态没有发现真实调用，因此不需要围绕旧 recovery descriptor 保留兼容层。保留工具名和“到期唤醒”的产品语义，内部改成独立的短期 schedule definition。

OpenClaw 的调度模型验证了 `at | every | cron` tagged union 的扩展方向，但它还承担多 Agent session、隔离执行、命令、delivery、webhook、run history 和失败告警。本项目只采用 schedule union 和 durable `nextRunAt` 的骨架，不复制完整 cron 平台。

## 非目标

- 不新增独立 `ShortPlan`、任务图、步骤依赖或多计划选择器。
- 不新增 worker thread、子进程、OS cron 或轮询循环。
- 不在 timer callback 中调用 LLM、执行工具或发送 QQ 消息。
- 不保存 shell、工具名、工具参数或其他待执行 payload。
- 不新增 isolated agent session、delivery route、run history、run-now、pause/resume 或 update。
- 不支持超过三天或永久驻留的 Agent 自建 cron。
- 不从 schedule side-data 重建 `AgentContext` 历史。

## 工具契约

`schedule` 保持 always-on，只提供三个动作：

```ts
type ScheduleArgs =
  | {
      action: 'create'
      name: string
      intention: string
      schedule:
        | { kind: 'at'; at: string }
        | { kind: 'at'; afterSeconds: number }
        | { kind: 'every'; everySeconds: number; anchorAt?: string }
        | { kind: 'cron'; expression: string; timezone?: string }
      maxRuns?: number
    }
  | { action: 'list' }
  | { action: 'cancel'; id: string }
```

- `name` 是稳定、简短、面向 Agent 的任务名，同一 active store 内唯一。
- `intention` 描述到期后要重新评估什么，不是必须执行的命令。
- `at` 是一次性触发；相对秒数在创建时归一化成绝对时间。
- `every` 是带稳定 anchor 的固定间隔，不按实际处理完成时间漂移。
- `cron` 使用正式 parser 解析表达式；默认时区是 `Asia/Shanghai`，也接受有效 IANA 时区。
- `maxRuns` 可以让周期任务早于三天上限自动结束。

第一版修改任务时使用 cancel 后重建。`list` 返回所有 active jobs 的紧凑摘要；`cancel` 对不存在的 ID 幂等返回 `already_absent`。

同名创建提供轻量幂等性：定义完全一致时返回已有任务；同名但定义不同则返回冲突和已有 `id`，并附带 `{ action: 'cancel', id }`，要求先 cancel。这可以避免工具重试产生重复计划，而不再增加 idempotency key。

`create` 和 `list` 的公开 schedule 摘要统一使用 `id`，只暴露 `id`、`name`、`intention`、`schedule`、`nextRunAt`、`expiresAt`、`runCount` 和可选 `maxRuns`；`cancel` 结果也返回 `id`。事件载荷的 `scheduleId` 仍是稳定事件字段，不与工具公开参数名混用。

## 硬边界

- `at` 必须位于创建时刻后 30 秒到 3 天之间。
- `every` 和 `cron` 的相邻触发至少间隔 5 分钟。
- 每个任务创建时固定 `expiresAt = createdAt + 3 天`；任何下一次触发不得超过该时间。
- 最多同时存在 20 个 active jobs。
- `name` 和 `intention` 有明确字符上限。
- 不接受动态代码、shell、工具调用或任意 payload。

以后若有长期例行任务的真实需求，应增加 owner/admin 边界或独立配置，不放宽 Agent 默认的三天权限。

## 持久模型

Schedule definition 不再伪装成 `BackgroundTask`。它保存到独立的 `data/agent-workspace/runtime/schedules.json`：

```ts
interface ScheduleStoreFile {
  version: 1
  schedules: ScheduleJob[]
}

interface ScheduleJob {
  id: string
  name: string
  intention: string
  schedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; everySeconds: number; anchorAt: string }
    | { kind: 'cron'; expression: string; timezone: string }
  createdAt: string
  expiresAt: string
  nextRunAt: string
  lastRunAt?: string
  runCount: number
  maxRuns?: number
}
```

持久时间字段使用带明确 offset 的 ISO 字符串，当前归一化为 UTC `Z`；工具公开结果和 `scheduled_wake` 渲染为北京时间 `+08:00`。文件使用临时文件加 rename 原子替换；写入失败时不发布新的内存快照。Store 只保留 active jobs：

- `at` 触发后删除。
- 周期任务达到 `maxRuns` 后删除。
- 下一次触发超过 `expiresAt` 时删除。
- `cancel` 删除对应 job。

工具结果、`scheduled_wake` 和运维日志已经分别承担 LLM 历史与诊断职责，schedule store 不再保存第二套执行历史。

## 运行模型

新增进程内 `ScheduleRuntime`，但不新增线程。当前 active jobs 上限只有 20，第一版为每个 job 使用一个 Node.js `setTimeout`，保留 `Map<scheduleId, handle>`：

```text
schedules.json
      ↓ 启动恢复
ScheduleRuntime（同一 Node event loop）
      ↓ setTimeout
BotEvent scheduled_wake
      ↓
单一 BotLoopAgent
```

创建流程：

1. 校验和归一化输入。
2. 检查三天边界、最短间隔、数量和同名任务。
3. 原子写入 store。
4. 挂载 timer。
5. 返回包含 `id`、`nextRunAt` 和 `expiresAt` 的公开 schedule 摘要。

触发流程：

1. 固定本次 `scheduledFor` 和递增后的 `runCount`。
2. `at` 准备删除；`every` / `cron` 从原 schedule 计算下一次时间；达到 `maxRuns` 或三天边界时也准备删除。
3. 先原子持久化新的 active job 集合；失败时不发布本次注意事件，短暂退避后重试。
4. 更新内存快照，必要时挂下一次 timer。
5. 最后向现有 event queue 注入稳定 `scheduled_wake`。

事件形态：

```json
{
  "event": "scheduled_wake",
  "scheduleId": "...",
  "name": "check-research",
  "scheduleKind": "at",
  "scheduledFor": "2026-07-13T18:00:00.000+08:00",
  "intention": "检查研究结果并决定下一步",
  "runCount": 1
}
```

Timer callback 只更新调度状态并入队，不启动模型或执行副作用。`BotLoopAgent` 继续串行处理所有注意事件；高优先私聊和 `@bot` 可以先处理，随后再重新评估 schedule intention。

Shutdown 清理全部 timer handle，但不改写持久 job。下次启动从 store 重建 timer。

## 重启与漏触发

启动读取和完整校验 store 后：

- 未到期任务重新挂 timer。
- 已过 `nextRunAt`、但仍在 `expiresAt` 内的 `at` 立即补一次唤醒。
- `every` / `cron` 错过多个时间点时只合并成一次唤醒，再计算下一个未来时间点。
- 已超过 `expiresAt` 的任务直接删除，不补唤醒。

这避免 Bot 停机后产生补跑风暴。Schedule wake 是让 Agent重新检查现实的注意事件，不承诺预存动作的 exactly-once 执行；事件包含稳定 `scheduleId + scheduledFor`，重复注意事件也必须重新评估，而不能盲目重放副作用。

## 错误处理

- schema、时间、cron、时区或边界校验失败时拒绝创建，不修改 store。
- 持久化失败时回滚内存状态并返回结构化错误。
- timer 触发后的持久化失败会记录错误，并在短暂退避后重新检查任务，不静默删除。
- 未知 store version 或损坏 JSON 在启动时明确失败并报告路径，不把损坏状态当成空列表。
- cancel 先持久化删除，再清理 timer；持久化失败则保留原任务和 timer。
- cron 计算不出三天内的下一次时间时拒绝创建，或在本次触发后自然完成。

## Prompt 引导

在常驻 system prompt 的 `[自主生活]` 后增加稳定 `[短期调度]` 指导，并在行动优先级中把 `scheduled_wake` 放在高优先通知之后、默认 Goal / 自由活动之前：

- 值得继续的事情当前不适合一直做，但未来三天内存在明确复查时间时，主动使用 `schedule`。
- 一次复查用 `at`，固定间隔实验用 `every`，墙上时间规则用 `cron`。
- `schedule` 不会停止当前活动；眼下短暂休息仍用 `pause`。
- 不用 schedule 等人回复、轮询新消息或机械刷新网站、群聊和行情。
- 不创建目的相同且时间重叠的任务；不确定时先 `list`。
- 周期任务应稀疏，并写清真正想观察的变化。
- `scheduled_wake` 是注意信号，不是不可变命令；先结合最新消息、Goal 和外部状态判断 intention 是否仍有效。
- 醒来后实际尝试一个有意义的步骤，或取消失效任务；不要什么都没做就原样重新安排。

职责对照保持明确：

```text
todo     = 当前准备立即执行的多步清单
schedule = 未来三天内重新获取注意力
goal     = 跨轮、跨重启的长期主线
Agenda   = 当前承诺和下一步，不负责定时触发
pause    = 眼下短暂休息
```

工具 description 只保留参数、三天边界、最短间隔、active 上限、到期只唤醒和取消方式。动态 job 状态只能通过 `schedule list` 或已经固定的 `scheduled_wake` 进入 ledger，不能拼入 system prompt。

## 验证

### 工具与计算

- `at` 的 30 秒下限和 3 天上限。
- `every` / `cron` 的 5 分钟下限。
- 相对时间归一化、cron parser、IANA 时区和下一次墙上时间。
- 同名同定义幂等、同名不同定义冲突、20 个 active 上限。
- `maxRuns`、`expiresAt` 和每次触发后的 next-run 计算。

### Store 与 Runtime

- 原子写入、未知版本、损坏 JSON 和写失败回滚。
- `at` 触发后删除。
- `every` 基于 anchor 计算而不漂移。
- cancel 同时清理持久状态和 timer。
- shutdown 后没有遗留 timer。
- timer callback 只入队，不调用 LLM 或工具。

### 恢复与集成

- 重启后重新挂载未到期任务。
- 过期但仍在生命周期内的 `at` 补一次。
- 周期任务错过多次只合并一次。
- 超过三天的任务清理且不唤醒。
- `scheduled_wake` 渲染成稳定 JSON 并进入 ledger。
- schedule wake 能结束休息，高优先 mailbox 仍可先处理，之后返回 active Goal。
- `schedule` 在默认 always-on 工具面中存在。

### Prompt

- system prompt 包含使用时机、醒后重判、三天边界、反轮询和职责对照。
- system prompt 不包含动态 schedule 状态。
- tool description 与实现 schema、时间限制和触发语义一致。
